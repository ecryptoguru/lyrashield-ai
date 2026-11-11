import {
  canonicalJson,
  providerGrantRequestSchema,
  providerGrantRevocationSchema,
  type JournalPort,
  type JournalRecord,
  type ProviderGrant,
  type ProviderGrantRequest,
  type ProviderGrantRevocation,
  type ProviderGrantStatus,
} from "@lyrashield/runtime-control"
import type { ProviderRoute } from "./config"
import { policyDigest, requestPolicySchema, type RequestPolicy } from "./request-policy"
import { type TerminalUsage } from "./provider-usage"
import { retainResponse, type RetainedResponse } from "./retained-response"
import { ProviderGatewayError } from "./errors"
import { grantIdFor } from "./grant-tokens"
import { type ProviderJournalEvent, type GrantState, type RequestState } from "./journal-events"
import { abortable } from "./proxy-utils"
import {
  prepareProxyRequest,
  type ProxyInput,
  type InFlightRequest,
  type ReadyProxyRequest,
} from "./proxy-request"
import { readProviderResponse, responseBinding } from "./proxy-response"
import { applyProviderJournalRecord, grantStatus, providerUsageId } from "./journal-state"

export { ProviderGatewayError } from "./errors"
export { providerJournalEventSchema } from "./journal-events"
export type { ProviderJournalEvent } from "./journal-events"

export interface ProviderGatewayServiceOptions {
  journal: JournalPort<ProviderJournalEvent>
  signingSecret: string
  responseEncryptionSecret?: string
  // Trusted broker adapter must revalidate the persisted attempt/authority
  // binding and return its approved policy; no request body supplies policy.
  authorizeGrant?: (request: ProviderGrantRequest) => Promise<RequestPolicy>
  admission: "closed" | "open"
  providers: ReadonlyMap<string, ProviderRoute>
  fetchImpl?: typeof fetch
  now?: () => Date
}

interface ProxyResponse {
  statusCode: number
  headers: Record<string, string>
  body: Buffer
  replayed: boolean
}

export class ProviderGatewayService {
  private initialized: Promise<void> | null = null
  private serial: Promise<void> = Promise.resolve()
  private readonly grants = new Map<string, GrantState>()
  private readonly grantsByRequest = new Map<string, string>()
  private readonly requests = new Map<string, RequestState>()
  private readonly inFlight = new Map<string, InFlightRequest>()
  private draining = false
  private failed = false

  constructor(private readonly options: ProviderGatewayServiceOptions) {
    if (Buffer.byteLength(options.signingSecret, "utf8") < 32) {
      throw new Error("provider gateway signing secret must be at least 32 bytes")
    }
    if (
      options.responseEncryptionSecret !== undefined &&
      Buffer.byteLength(options.responseEncryptionSecret) < 32
    )
      throw new Error("response encryption key must be at least 32 bytes")
  }

  async initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.load()
    await this.initialized
  }

  async drain(): Promise<void> {
    this.draining = true
    await this.serial
    const active = [...this.inFlight.values()]
    for (const request of active) request.controller.abort()
    await Promise.all(active.map((request) => request.done))
    await this.serial
    if (this.inFlight.size > 0) {
      throw new ProviderGatewayError(
        "SHUTDOWN_UNCERTAIN",
        "provider requests remain unresolved",
        503
      )
    }
  }

  async issueGrant(input: unknown): Promise<ProviderGrant> {
    return this.serialized(async () => {
      await this.initialize()
      const parsed = providerGrantRequestSchema.safeParse(input)
      if (!parsed.success) {
        throw new ProviderGatewayError(
          "INVALID_GRANT_REQUEST",
          "provider grant request is invalid",
          400
        )
      }
      const request = parsed.data
      if (this.failed || this.draining || this.options.admission !== "open")
        throw new ProviderGatewayError("ADMISSION_CLOSED", "runtime admission is closed")
      const route = this.options.providers.get(request.providerId)
      if (!route)
        throw new ProviderGatewayError("PROVIDER_NOT_ALLOWED", "provider is not configured")
      if (Date.parse(request.expiresAt) <= this.now().getTime()) {
        throw new ProviderGatewayError(
          "GRANT_EXPIRED",
          "provider grant expiry is not in the future"
        )
      }
      if (Date.parse(request.expiresAt) - this.now().getTime() > 86_400_000)
        throw new ProviderGatewayError(
          "INVALID_GRANT_EXPIRY",
          "provider grant lifetime exceeds one day",
          400
        )
      const existingId = this.grantsByRequest.get(request.grantRequestId)
      if (existingId) {
        const existing = this.grants.get(existingId)
        if (!existing)
          throw new ProviderGatewayError("JOURNAL_INTEGRITY", "grant index is corrupt", 500)
        if (canonicalJson(existing.request) !== canonicalJson(request)) {
          throw new ProviderGatewayError(
            "IDEMPOTENCY_CONFLICT",
            "grant request id was reused with different input"
          )
        }
        const policy = await this.authorizedPolicy(existing.request, route)
        if (!existing.policy || policyDigest(policy) !== policyDigest(existing.policy))
          throw new ProviderGatewayError(
            "POLICY_CHANGED",
            "provider grant requires renewed broker authorization"
          )
        this.assertGrantActive(existing)
        return this.grantResponse(existing)
      }
      const policy = await this.authorizedPolicy(request, route)
      if (Date.parse(request.expiresAt) <= this.now().getTime())
        throw new ProviderGatewayError("GRANT_EXPIRED", "provider grant is expired")
      const grantId = grantIdFor(request)
      const record = await this.options.journal.append({
        type: "grant_issued",
        grant: { grantRequestId: request.grantRequestId, grantId, request, policy },
      })
      this.apply(record)
      const grant = this.grants.get(grantId)
      if (!grant)
        throw new ProviderGatewayError(
          "JOURNAL_INTEGRITY",
          "issued grant was not reconstructed",
          500
        )
      this.assertGrantActive(grant)
      return this.grantResponse(grant)
    })
  }

  async findGrantByRequest(grantRequestId: string): Promise<ProviderGrant | null> {
    await this.initialize()
    const grantId = this.grantsByRequest.get(grantRequestId)
    if (!grantId) return null
    const grant = this.grants.get(grantId)
    return grant ? this.grantResponse(grant) : null
  }

  async revokeGrant(input: ProviderGrantRevocation): Promise<ProviderGrantStatus> {
    return this.serialized(async () => {
      await this.initialize()
      const parsed = providerGrantRevocationSchema.safeParse(input)
      if (!parsed.success) {
        throw new ProviderGatewayError(
          "INVALID_REVOCATION",
          "provider grant revocation is invalid",
          400
        )
      }
      const request = parsed.data
      const grant = this.grants.get(request.grantId)
      if (!grant) throw new ProviderGatewayError("GRANT_NOT_FOUND", "provider grant not found", 404)
      if (grant.request.attemptId !== request.attemptId) {
        throw new ProviderGatewayError(
          "GRANT_BINDING_MISMATCH",
          "provider grant belongs to another attempt"
        )
      }
      try {
        if (!grant.revokedAt) {
          const record = await this.options.journal.append({
            type: "grant_revoked",
            revocation: {
              grantId: grant.grantId,
              attemptId: grant.request.attemptId,
              reason: request.reason,
              revokedAt: this.now().toISOString(),
            },
          })
          this.apply(record)
        }
      } finally {
        // A failed journal write makes revocation uncertain, but must not
        // prevent a best-effort local abort of requests already in flight.
        for (const active of this.inFlight.values()) {
          if (active.grantId === grant.grantId) active.controller.abort()
        }
      }
      const current = this.grants.get(grant.grantId)
      if (!current)
        throw new ProviderGatewayError("JOURNAL_INTEGRITY", "revoked grant disappeared", 500)
      return grantStatus(current)
    })
  }

  async inspectGrant(grantId: string): Promise<ProviderGrantStatus | null> {
    await this.initialize()
    const grant = this.grants.get(grantId)
    return grant ? grantStatus(grant) : null
  }

  // Private control-plane status only. This is a local journal receipt,
  // not independent settlement or authorization to release a billing hold.
  async inspectRequest(requestId: string) {
    await this.initialize()
    const request = this.requests.get(requestId)
    if (!request) return null
    const grant = this.grants.get(request.grantId)
    if (!grant) throw new ProviderGatewayError("JOURNAL_INTEGRITY", "request grant is missing", 500)
    return {
      version: 1 as const,
      requestId,
      grantId: request.grantId,
      attemptId: request.attemptId,
      scanId: grant.request.scanId,
      workspaceId: grant.request.workspaceId,
      operationId: grant.request.operationId,
      authorityEpochId: grant.request.authorityEpochId,
      authorityRevision: grant.request.authorityRevision,
      providerId: request.providerId,
      outcome: request.outcome,
      physicalOutstanding: request.physicalOutstanding,
      policyDigest: request.policyDigest ?? null,
      usage: request.usage ?? null,
      usageId: request.usageId ?? null,
      reservationMicros: request.reservationMicros,
      receipt: request.receipt ?? null,
    }
  }

  private async prepareProxy(input: ProxyInput) {
    await this.initialize()
    return prepareProxyRequest(
      {
        options: this.options,
        admissionClosed: this.failed || this.draining,
        grants: this.grants,
        requests: this.requests,
        inFlight: this.inFlight,
        assertGrantActive: (grant) => this.assertGrantActive(grant),
        authorizedPolicy: (request, route) => this.authorizedPolicy(request, route),
        apply: (record) => this.apply(record),
      },
      input
    )
  }

  async proxy(input: ProxyInput): Promise<ProxyResponse> {
    const prepared = await this.serialized(() => this.prepareProxy(input))
    if (prepared.kind === "replay") {
      // Honor revocations queued while broker authorization was awaited.
      await this.serialized(async () => this.assertGrantActive(prepared.grant))
      this.assertGrantActive(prepared.grant)
      return prepared.response
    }
    const { controller, policy, approved, grant } = prepared
    const deadline = setTimeout(() => controller.abort(), policy.deadlineMs)
    const expiry = setTimeout(
      () => controller.abort(),
      Math.max(
        1,
        Date.parse(
          this.grants.get(this.requests.get(input.requestId)?.grantId ?? "")?.request.expiresAt ??
            ""
        ) - this.now().getTime()
      )
    )
    const signal = controller.signal
    try {
      const upstream = await this.dispatchProxy(input, prepared)
      const { responseBody, usage, responseHash } = await readProviderResponse(
        upstream,
        policy,
        approved,
        signal,
        () =>
          this.serialized(() =>
            this.recordResult(
              input.requestId,
              "UNKNOWN",
              upstream.status,
              undefined,
              undefined,
              "provider response or terminal usage is unavailable"
            )
          )
      )
      const outcome = upstream.ok ? "SUCCEEDED" : "FAILED"
      const responseHeaders: Record<string, string> = {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "x-lyra-request-id": input.requestId,
      }
      const result = await this.serialized(async () => {
        if (controller.signal.aborted) {
          await this.recordResult(
            input.requestId,
            "UNKNOWN",
            undefined,
            undefined,
            undefined,
            "provider request was aborted after revocation"
          )
          throw new ProviderGatewayError("PROVIDER_UNAVAILABLE", "provider outcome is unknown", 502)
        }
        const state = this.requests.get(input.requestId)
        if (!state) throw new ProviderGatewayError("JOURNAL_INTEGRITY", "request is missing", 500)
        if (
          usage &&
          [...this.requests.values()].some(
            (request) =>
              request.requestId !== input.requestId &&
              request.providerId === state.providerId &&
              request.usage?.providerResponseId === usage.providerResponseId
          )
        ) {
          await this.recordResult(
            input.requestId,
            "UNKNOWN",
            upstream.status,
            undefined,
            undefined,
            "provider response identity was reused"
          )
          throw new ProviderGatewayError(
            "PROVIDER_USAGE_UNKNOWN",
            "provider response identity is ambiguous",
            502
          )
        }
        const usageId = usage
          ? providerUsageId(this.options.signingSecret, state, usage)
          : undefined
        if (usageId) responseHeaders["x-lyra-usage-id"] = usageId
        const binding = responseBinding({
          ...state,
          statusCode: upstream.status,
          responseHash,
          responseBytes: responseBody.byteLength,
          usage,
        })
        const retainedResponse = retainResponse(
          this.options.responseEncryptionSecret ?? "",
          binding,
          { statusCode: upstream.status, headers: responseHeaders, body: responseBody }
        )
        return this.recordResult(
          input.requestId,
          outcome,
          upstream.status,
          responseHash,
          responseBody.byteLength,
          undefined,
          usage,
          retainedResponse
        )
      })
      if (result.usageId) responseHeaders["x-lyra-usage-id"] = result.usageId
      await this.serialized(async () => this.assertGrantActive(grant))
      this.assertGrantActive(grant)
      if (controller.signal.aborted)
        throw new ProviderGatewayError(
          "PROVIDER_UNAVAILABLE",
          "provider response return was aborted",
          502
        )
      return {
        statusCode: upstream.status,
        headers: responseHeaders,
        body: responseBody,
        replayed: false,
      }
    } finally {
      clearTimeout(deadline)
      clearTimeout(expiry)
      this.inFlight.get(input.requestId)?.finish()
      this.inFlight.delete(input.requestId)
    }
  }

  private async dispatchProxy(input: ProxyInput, prepared: ReadyProxyRequest): Promise<Response> {
    const { target, headers, controller, grant } = prepared
    const signal = controller.signal
    try {
      // The last grant check and fetch invocation share the serialization
      // boundary with revocation. Return the promise inside an object so
      // slow providers never hold the control-plane serialization lock.
      const dispatched = await this.serialized(async () => {
        this.assertGrantActive(grant)
        if (controller.signal.aborted)
          throw new ProviderGatewayError(
            "PROVIDER_UNAVAILABLE",
            "provider dispatch was aborted",
            502
          )
        return {
          upstream: (this.options.fetchImpl ?? fetch)(target, {
            method: input.method,
            headers,
            body: input.body.byteLength > 0 ? input.body : undefined,
            redirect: "error",
            signal,
          }),
        }
      })
      return await abortable(dispatched.upstream, signal)
    } catch (error) {
      await this.serialized(() =>
        this.recordResult(
          input.requestId,
          "UNKNOWN",
          undefined,
          undefined,
          undefined,
          "upstream outcome unavailable"
        )
      )
      if (error instanceof ProviderGatewayError) throw error
      throw new ProviderGatewayError("PROVIDER_UNAVAILABLE", "provider outcome is unknown", 502)
    }
  }

  private assertGrantActive(grant: GrantState): void {
    if (this.failed || this.draining || this.options.admission !== "open")
      throw new ProviderGatewayError("ADMISSION_CLOSED", "runtime admission is closed")
    if (grant.revokedAt)
      throw new ProviderGatewayError("GRANT_REVOKED", "provider grant is revoked")
    if (Date.parse(grant.request.expiresAt) <= this.now().getTime())
      throw new ProviderGatewayError("GRANT_EXPIRED", "provider grant is expired")
  }

  private async authorizedPolicy(
    request: ProviderGrantRequest,
    route: ProviderRoute
  ): Promise<RequestPolicy> {
    if (
      !this.options.authorizeGrant ||
      !route.requestPolicy ||
      !this.options.responseEncryptionSecret ||
      Buffer.byteLength(this.options.responseEncryptionSecret) < 32
    )
      throw new ProviderGatewayError(
        "BROKER_AUTHORIZATION_REQUIRED",
        "trusted broker policy and encrypted retention are required"
      )
    const policy = requestPolicySchema.parse(await this.options.authorizeGrant(request))
    if (policyDigest(policy) !== policyDigest(requestPolicySchema.parse(route.requestPolicy)))
      throw new ProviderGatewayError(
        "POLICY_DENIED",
        "broker policy does not match the server-approved adapter"
      )
    return policy
  }

  private grantResponse(grant: GrantState): ProviderGrant {
    return {
      grantId: grant.grantId,
      token: grant.token,
      attemptId: grant.request.attemptId,
      providerId: grant.request.providerId,
      expiresAt: grant.request.expiresAt,
      receipt: grant.receiptHash,
    }
  }

  private async recordResult(
    requestId: string,
    outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN",
    statusCode?: number,
    responseHash?: string,
    responseBytes?: number,
    detail?: string,
    usage?: TerminalUsage,
    retainedResponse?: RetainedResponse
  ): Promise<RequestState> {
    const state = this.requests.get(requestId)
    if (!state) throw new ProviderGatewayError("JOURNAL_INTEGRITY", "request is missing", 500)
    const usageId = usage ? providerUsageId(this.options.signingSecret, state, usage) : undefined
    const record = await this.options.journal.append({
      type: "request_result",
      result: {
        requestId,
        grantId: this.requests.get(requestId)?.grantId ?? "",
        attemptId: this.requests.get(requestId)?.attemptId ?? "",
        outcome,
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(responseHash ? { responseHash } : {}),
        ...(responseBytes !== undefined ? { responseBytes } : {}),
        ...(usageId ? { usageId } : {}),
        ...(usage ? { usage } : {}),
        ...(retainedResponse ? { retainedResponse } : {}),
        ...(detail ? { detail } : {}),
      },
    })
    this.apply(record)
    const result = this.requests.get(requestId)
    if (!result)
      throw new ProviderGatewayError("JOURNAL_INTEGRITY", "request result is missing", 500)
    return result
  }

  private apply(record: JournalRecord<ProviderJournalEvent>): void {
    applyProviderJournalRecord(
      { grants: this.grants, grantsByRequest: this.grantsByRequest, requests: this.requests },
      this.options.signingSecret,
      record
    )
  }

  private async load(): Promise<void> {
    const records = await this.options.journal.load()
    for (const record of records) this.apply(record)
    for (const request of this.requests.values()) {
      if (request.outcome === "PENDING") {
        await this.recordResult(
          request.requestId,
          "UNKNOWN",
          undefined,
          undefined,
          undefined,
          "provider gateway restarted with an unresolved request"
        )
      } else if (request.outcome === "SUCCEEDED" && (!request.usage || !request.retainedResponse)) {
        // Append recovery uncertainty without rewriting historical receipts.
        const record = await this.options.journal.append({
          type: "legacy_request_uncertain",
          requestId: request.requestId,
          grantId: request.grantId,
          attemptId: request.attemptId,
        })
        this.apply(record)
      }
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult: (value: T) => void = () => undefined
    let rejectResult: (error: unknown) => void = () => undefined
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise
      rejectResult = rejectPromise
    })
    const run = this.serial.then(async () => {
      try {
        resolveResult(await operation())
      } catch (error) {
        if (!(error instanceof ProviderGatewayError)) this.failed = true
        rejectResult(error)
      }
    })
    this.serial = run.catch(() => undefined)
    await run
    return result
  }
}
