import { performance } from "node:perf_hooks"
import { createHmac, createHash } from "node:crypto"
import {
  canonicalJson,
  providerGrantRequestSchema,
  providerGrantRevocationSchema,
  providerGrantStatusSchema,
  sha256Hex,
  type JournalPort,
  type JournalRecord,
  type ProviderGrant,
  type ProviderGrantRequest,
  type ProviderGrantRevocation,
  type ProviderGrantStatus,
} from "@lyrashield/runtime-control"
import type { ProviderRoute } from "./config"
import {
  authorizeRequest,
  policyDigest,
  requestPolicySchema,
  type RequestPolicy,
} from "./request-policy"
import { ResponsesUsageParser, type TerminalUsage } from "./provider-usage"
import { retainResponse, replayResponse, type RetainedResponse } from "./retained-response"
import { ProviderGatewayError } from "./errors"
import type { ProviderStreamSink } from "./downstream"
import { grantIdFor, signToken, verifyToken } from "./grant-tokens"
import { type ProviderJournalEvent, type GrantState, type RequestState } from "./journal-events"
import {
  abortable,
  readBoundedResponse,
  resolveProviderUrl,
  normalizeHeaderValue,
  MAX_DELIVERY_CHUNK_BYTES,
} from "./proxy-utils"

export { ProviderGatewayError } from "./errors"
export { providerJournalEventSchema } from "./journal-events"
export type { ProviderJournalEvent } from "./journal-events"

const MAX_UPSTREAM_BODY_BYTES = 4 * 1024 * 1024
const MAX_OUTSTANDING_PROVIDER_REQUESTS = 8

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

function grantStatus(grant: GrantState): ProviderGrantStatus {
  return providerGrantStatusSchema.parse({
    grantId: grant.grantId,
    attemptId: grant.request.attemptId,
    providerId: grant.request.providerId,
    expiresAt: grant.request.expiresAt,
    revokedAt: grant.revokedAt,
    requestCount: grant.requestCount,
    reservedCostMicros: grant.reservedCostMicros,
    receipt: grant.receiptHash,
  })
}

interface ProxyInput {
  scanId?: string
  providerId: string
  path: string
  method: string
  authorization: string
  requestId: string
  contentType?: string
  accept?: string
  body: Buffer
}
interface ProxyResponse {
  statusCode: number
  headers: Record<string, string>
  body: Buffer
  replayed: boolean
  streamed?: true
}
interface DeliveryState {
  grantId?: string
  controller: AbortController
  done: Promise<void>
  finish: () => void
}

export class ProviderGatewayService {
  private initialized: Promise<void> | null = null
  private serial: Promise<void> = Promise.resolve()
  private readonly grants = new Map<string, GrantState>()
  private readonly grantsByRequest = new Map<string, string>()
  private readonly requests = new Map<string, RequestState>()
  private readonly inFlight = new Map<
    string,
    {
      grantId: string
      controller: AbortController
      done: Promise<void>
      finish: () => void
    }
  >()
  private draining = false
  private readonly deliveries = new Map<symbol, DeliveryState>()
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
    const active = [...this.inFlight.values(), ...this.deliveries.values()]
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
        for (const active of this.deliveries.values()) {
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

  private async prepareProxy(input: ProxyInput, delivery?: DeliveryState) {
    await this.initialize()
    if (this.failed || this.draining || this.options.admission !== "open")
      throw new ProviderGatewayError("ADMISSION_CLOSED", "runtime admission is closed")
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/.test(input.requestId)) {
      throw new ProviderGatewayError("INVALID_REQUEST_ID", "request identity is invalid", 400)
    }
    const route = this.options.providers.get(input.providerId)
    if (!route) throw new ProviderGatewayError("PROVIDER_NOT_ALLOWED", "provider is not configured")
    const token = input.authorization.startsWith("Bearer ")
      ? input.authorization.slice("Bearer ".length)
      : ""
    const verified = verifyToken(this.options.signingSecret, token)
    const grant = this.grants.get(verified.grantId)
    if (!grant) throw new ProviderGatewayError("GRANT_NOT_FOUND", "provider grant not found")
    if (delivery) delivery.grantId = grant.grantId
    if (
      (input.scanId !== undefined && input.scanId !== grant.request.scanId) ||
      grant.request.providerId !== input.providerId ||
      grant.request.attemptId !== verified.attemptId ||
      grant.request.providerId !== verified.providerId ||
      grant.request.scanId !== verified.scanId ||
      grant.request.workspaceId !== verified.workspaceId ||
      grant.request.operationId !== verified.operationId ||
      grant.request.authorityEpochId !== verified.authorityEpochId ||
      grant.request.authorityRevision !== verified.authorityRevision ||
      grant.request.expiresAt !== verified.expiresAt ||
      (grant.policy ? policyDigest(grant.policy) : null) !== verified.policyDigest
    ) {
      throw new ProviderGatewayError(
        "GRANT_BINDING_MISMATCH",
        "provider grant binding does not match the request"
      )
    }
    this.assertGrantActive(grant)
    if ((input.contentType?.length ?? 0) > 256) {
      throw new ProviderGatewayError("INVALID_CONTENT_TYPE", "content type header is invalid", 400)
    }
    if ((input.accept?.length ?? 0) > 1_024) {
      throw new ProviderGatewayError("INVALID_ACCEPT", "accept header is invalid", 400)
    }
    if (input.body.byteLength > MAX_UPSTREAM_BODY_BYTES) {
      throw new ProviderGatewayError(
        "REQUEST_TOO_LARGE",
        "provider request exceeds the byte cap",
        413
      )
    }
    const target = resolveProviderUrl(route, input.path)
    const bodyHash = sha256Hex(input.body.toString("base64"))
    const method = input.method.toUpperCase()
    const contentType = normalizeHeaderValue(input.contentType)
    const accept = normalizeHeaderValue(input.accept ?? "application/json")
    const existing = this.requests.get(input.requestId)
    if (existing) {
      if (
        existing.grantId !== grant.grantId ||
        existing.path !== target.pathname ||
        existing.query !== target.search ||
        existing.method !== method ||
        existing.contentType !== contentType ||
        existing.accept !== accept ||
        existing.bodyHash !== bodyHash
      ) {
        throw new ProviderGatewayError(
          "IDEMPOTENCY_CONFLICT",
          "request id was reused with different input"
        )
      }
      const policy = await this.authorizedPolicy(grant.request, route)
      if (!grant.policy || policyDigest(policy) !== policyDigest(grant.policy))
        throw new ProviderGatewayError(
          "POLICY_CHANGED",
          "provider grant requires renewed broker authorization"
        )
      if (
        (existing.outcome === "SUCCEEDED" || existing.outcome === "FAILED") &&
        existing.retainedResponse &&
        this.options.responseEncryptionSecret
      ) {
        const response = replayResponse(
          this.options.responseEncryptionSecret,
          this.responseBinding(existing),
          existing.retainedResponse,
          existing
        )
        this.assertGrantActive(grant)
        return {
          kind: "replay" as const,
          grant,
          response: {
            ...response,
            headers: { ...response.headers, "x-lyra-replayed": "true" },
            replayed: true,
          },
        }
      }
      throw new ProviderGatewayError(
        existing.outcome === "PENDING" ? "REQUEST_IN_PROGRESS" : "REQUEST_UNKNOWN",
        "request identity cannot be replayed",
        409
      )
    }
    const policy = await this.authorizedPolicy(grant.request, route)
    if (!grant.policy || policyDigest(policy) !== policyDigest(grant.policy))
      throw new ProviderGatewayError(
        "POLICY_CHANGED",
        "provider grant requires renewed broker authorization"
      )
    const approved = authorizeRequest(policy, {
      path: `${target.pathname}${target.search}`,
      method,
      contentType,
      body: input.body,
    })
    this.assertGrantActive(grant)
    const outstanding = [...this.requests.values()].filter((request) => request.physicalOutstanding)
    if (
      outstanding.length >= MAX_OUTSTANDING_PROVIDER_REQUESTS ||
      outstanding.filter((request) => request.grantId === grant.grantId).length >=
        policy.maxConcurrentRequests
    )
      throw new ProviderGatewayError(
        "PROVIDER_CONCURRENCY_EXHAUSTED",
        "provider concurrency is exhausted",
        429
      )
    if (grant.requestCount >= Math.min(grant.request.maxRequests, policy.maxRequests)) {
      throw new ProviderGatewayError(
        "GRANT_REQUEST_BUDGET_EXHAUSTED",
        "provider grant request budget is exhausted"
      )
    }
    if (
      grant.reservedCostMicros + approved.reservationMicros >
      Math.min(grant.request.maxReservedCostMicros, policy.maxGrantReservedCostMicros)
    ) {
      throw new ProviderGatewayError(
        "GRANT_COST_BUDGET_EXHAUSTED",
        "provider grant cost reservation is exhausted"
      )
    }
    const startRecord = await this.options.journal.append({
      type: "request_started",
      request: {
        requestId: input.requestId,
        grantId: grant.grantId,
        attemptId: grant.request.attemptId,
        providerId: input.providerId,
        path: target.pathname,
        query: target.search,
        method,
        contentType,
        accept,
        bodyHash,
        reservationMicros: approved.reservationMicros,
        policyDigest: policyDigest(policy),
        model: approved.model,
        maxOutputTokens: approved.maxOutputTokens,
        stream: approved.stream,
      },
    })
    this.apply(startRecord)
    const headers: Record<string, string> = {
      accept,
      "x-lyra-request-id": input.requestId,
    }
    headers["content-type"] = contentType
    if (route.auth.kind === "authorization") {
      headers.authorization = route.auth.credential.startsWith("Bearer ")
        ? route.auth.credential
        : `Bearer ${route.auth.credential}`
    } else {
      headers[route.auth.headerName] = route.auth.credential
    }
    const controller = new AbortController()
    let finish: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.inFlight.set(input.requestId, { grantId: grant.grantId, controller, done, finish })
    return { kind: "ready" as const, target, headers, controller, policy, approved, grant }
  }

  async proxy(input: ProxyInput, sink?: ProviderStreamSink): Promise<ProxyResponse> {
    if (sink && !input.scanId)
      throw new ProviderGatewayError(
        "SCAN_ID_REQUIRED",
        "scan-bound downstream delivery is required",
        400
      )
    if (sink?.signal.aborted)
      throw new ProviderGatewayError("DOWNSTREAM_DISCONNECTED", "downstream is disconnected", 409)
    if (!sink) return this.executeProxy(input)
    if (this.deliveries.size >= MAX_OUTSTANDING_PROVIDER_REQUESTS)
      throw new ProviderGatewayError(
        "DELIVERY_CONCURRENCY_EXHAUSTED",
        "delivery concurrency is exhausted",
        429
      )
    const identity = Symbol()
    let finish: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const delivery = { controller: new AbortController(), done, finish }
    this.deliveries.set(identity, delivery)
    try {
      return await this.executeProxy(input, sink, delivery)
    } finally {
      this.deliveries.delete(identity)
      finish()
    }
  }

  private async executeProxy(
    input: ProxyInput,
    sink?: ProviderStreamSink,
    delivery?: DeliveryState
  ): Promise<ProxyResponse> {
    const prepared = await this.serialized(() => this.prepareProxy(input, delivery))
    if (prepared.kind === "replay") {
      // Honor revocations queued while broker authorization was awaited.
      await this.serialized(async () => this.assertGrantActive(prepared.grant))
      this.assertGrantActive(prepared.grant)
      if (sink && this.requests.get(input.requestId)?.stream) {
        const policy = prepared.grant.policy
        if (!policy || !delivery)
          throw new ProviderGatewayError("JOURNAL_INTEGRITY", "replay policy is unavailable", 500)
        const deadlineAt = performance.now() + policy.deadlineMs
        const timeout = setTimeout(
          () => delivery.controller.abort(),
          Math.min(
            policy.deadlineMs,
            Math.max(1, Date.parse(prepared.grant.request.expiresAt) - this.now().getTime())
          )
        )
        const signal = AbortSignal.any([sink.signal, delivery.controller.signal])
        try {
          await this.deliverEffect(prepared.grant, signal, policy.idleTimeoutMs, deadlineAt, () =>
            sink.start(prepared.response.statusCode, prepared.response.headers)
          )
          for (
            let offset = 0;
            offset < prepared.response.body.byteLength;
            offset += MAX_DELIVERY_CHUNK_BYTES
          )
            await this.deliverEffect(prepared.grant, signal, policy.idleTimeoutMs, deadlineAt, () =>
              sink.write(prepared.response.body.subarray(offset, offset + MAX_DELIVERY_CHUNK_BYTES))
            )
          await this.deliverEffect(prepared.grant, signal, policy.idleTimeoutMs, deadlineAt, () =>
            sink.complete()
          )
          return { ...prepared.response, streamed: true }
        } finally {
          clearTimeout(timeout)
        }
      }
      return prepared.response
    }
    const { target, headers, controller, policy, approved, grant } = prepared
    const deadlineAt = performance.now() + policy.deadlineMs
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
    const activeSink = approved.stream ? sink : undefined
    const signal = sink
      ? AbortSignal.any([controller.signal, sink.signal, delivery!.controller.signal])
      : controller.signal
    try {
      let upstream: Response
      try {
        // The last grant check and fetch invocation share the serialization
        // boundary with revocation. Return the promise inside an object so
        // slow providers never hold the control-plane serialization lock.
        const dispatched = await this.serialized(async () => {
          this.assertGrantActive(grant)
          if (signal.aborted || performance.now() >= deadlineAt)
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
        upstream = await abortable(dispatched.upstream, signal)
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
      const parser = new ResponsesUsageParser(policy, {
        ...approved,
        policyDigest: policyDigest(policy),
      })
      const responseHasher = createHash("sha256")
      const responseHeaders: Record<string, string> = {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "x-lyra-request-id": input.requestId,
      }
      let responseBody: Buffer
      let usage: TerminalUsage | undefined
      try {
        if (
          !upstream.ok ||
          upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
            (approved.stream ? "text/event-stream" : "application/json")
        )
          throw new Error("provider response encoding or outcome is unavailable")
        if (activeSink)
          await this.deliverEffect(grant, signal, policy.idleTimeoutMs, deadlineAt, () =>
            activeSink.start(upstream.status, responseHeaders)
          )
        responseBody = await abortable(
          readBoundedResponse(upstream, policy.maxResponseBytes, {
            signal,
            deadlineAt,
            idleTimeoutMs: policy.idleTimeoutMs,
            onChunk: async (chunk) => {
              responseHasher.update(chunk)
              parser.push(chunk)
              if (activeSink)
                await this.deliverEffect(grant, signal, policy.idleTimeoutMs, deadlineAt, () =>
                  activeSink.write(chunk)
                )
            },
          }),
          signal
        )
        if (upstream.ok) {
          const contentType = upstream.headers
            .get("content-type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase()
          if (contentType !== (approved.stream ? "text/event-stream" : "application/json"))
            throw new Error("provider response encoding mismatch")
          usage = parser.finish()
        } else throw new Error("provider returned no affirmative terminal usage")
        if (activeSink)
          await this.deliverEffect(grant, signal, policy.idleTimeoutMs, deadlineAt, () =>
            activeSink.complete()
          )
      } catch {
        controller.abort()
        await this.serialized(() =>
          this.recordResult(
            input.requestId,
            "UNKNOWN",
            upstream.status,
            undefined,
            undefined,
            "provider response or terminal usage is unavailable"
          )
        )
        throw new ProviderGatewayError(
          "PROVIDER_RESPONSE_UNKNOWN",
          "provider response or terminal usage is unknown",
          502
        )
      }
      const outcome = upstream.ok ? "SUCCEEDED" : "FAILED"
      const responseHash = responseHasher.digest("hex")
      const result = await this.serialized(async () => {
        if (
          signal.aborted ||
          performance.now() >= deadlineAt ||
          grant.revokedAt ||
          Date.parse(grant.request.expiresAt) <= this.now().getTime()
        ) {
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
        const usageId = usage ? this.usageId(state, usage) : undefined
        if (usageId && !activeSink) responseHeaders["x-lyra-usage-id"] = usageId
        const binding = this.responseBinding({
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
      if (result.usageId && !activeSink) responseHeaders["x-lyra-usage-id"] = result.usageId
      await this.serialized(async () => this.assertGrantActive(grant))
      this.assertGrantActive(grant)
      if (signal.aborted || performance.now() >= deadlineAt)
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
        ...(activeSink ? { streamed: true as const } : {}),
      }
    } catch (error) {
      if (activeSink) {
        await this.serialized(async () => {
          const request = this.requests.get(input.requestId)
          if (request && (request.outcome === "PENDING" || request.outcome === "SUCCEEDED")) {
            const record = await this.options.journal.append({
              type: "stream_delivery_uncertain",
              requestId: request.requestId,
              grantId: request.grantId,
              attemptId: request.attemptId,
            })
            this.apply(record)
          }
        })
      }
      throw error
    } finally {
      clearTimeout(deadline)
      clearTimeout(expiry)
      this.inFlight.get(input.requestId)?.finish()
      this.inFlight.delete(input.requestId)
    }
  }

  private async deliverEffect(
    grant: GrantState,
    signal: AbortSignal,
    idleTimeoutMs: number,
    deadlineAt: number,
    effect: () => void | Promise<void>
  ): Promise<void> {
    const submitted = await this.serialized(async () => {
      this.assertGrantActive(grant)
      if (signal.aborted || performance.now() >= deadlineAt)
        throw new ProviderGatewayError("DOWNSTREAM_DISCONNECTED", "delivery was aborted", 409)
      return { done: effect() }
    })
    await abortable(Promise.resolve(submitted.done), signal, idleTimeoutMs)
    this.assertGrantActive(grant)
    if (signal.aborted || performance.now() >= deadlineAt)
      throw new ProviderGatewayError("DOWNSTREAM_DISCONNECTED", "delivery was aborted", 409)
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

  private usageId(state: RequestState, usage: TerminalUsage): string {
    return `usage_${createHmac("sha256", this.options.signingSecret)
      .update(
        canonicalJson({
          version: 1,
          requestId: state.requestId,
          grantId: state.grantId,
          attemptId: state.attemptId,
          providerId: state.providerId,
          usage,
        })
      )
      .digest("hex")
      .slice(0, 40)}`
  }

  private responseBinding(state: RequestState) {
    return {
      version: 1,
      requestId: state.requestId,
      grantId: state.grantId,
      attemptId: state.attemptId,
      providerId: state.providerId,
      path: state.path,
      query: state.query,
      method: state.method,
      contentType: state.contentType,
      accept: state.accept,
      bodyHash: state.bodyHash,
      policyDigest: state.policyDigest ?? null,
      statusCode: state.statusCode ?? null,
      responseHash: state.responseHash ?? null,
      responseBytes: state.responseBytes ?? null,
      usage: state.usage ?? null,
    }
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
    const usageId = usage ? this.usageId(state, usage) : undefined
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
    const event = record.payload
    if (event.type === "grant_issued") {
      this.grants.set(event.grant.grantId, {
        request: event.grant.request,
        policy: event.grant.policy,
        grantId: event.grant.grantId,
        token: signToken(
          this.options.signingSecret,
          event.grant.request,
          event.grant.grantId,
          event.grant.policy ? policyDigest(event.grant.policy) : null
        ),
        revokedAt: null,
        requestCount: 0,
        reservedCostMicros: 0,
        receiptHash: record.hash,
      })
      this.grantsByRequest.set(event.grant.grantRequestId, event.grant.grantId)
      return
    }
    if (event.type === "grant_revoked") {
      const grant = this.grants.get(event.revocation.grantId)
      if (grant) {
        grant.revokedAt = event.revocation.revokedAt
        grant.receiptHash = record.hash
      }
      return
    }
    if (event.type === "request_started") {
      const request = event.request
      this.requests.set(request.requestId, {
        ...request,
        outcome: "PENDING",
        physicalOutstanding: true,
        receiptHash: record.hash,
        receipt: { sequence: record.sequence, hash: record.hash, signature: record.signature },
      })
      const grant = this.grants.get(request.grantId)
      if (grant) {
        grant.requestCount += 1
        grant.reservedCostMicros += request.reservationMicros
        grant.receiptHash = record.hash
      }
      return
    }
    if (event.type === "stream_delivery_uncertain") {
      const existing = this.requests.get(event.requestId)
      if (
        !existing ||
        !existing.stream ||
        (existing.outcome !== "PENDING" && existing.outcome !== "SUCCEEDED") ||
        existing.grantId !== event.grantId ||
        existing.attemptId !== event.attemptId
      )
        throw new ProviderGatewayError(
          "JOURNAL_INTEGRITY",
          "stream uncertainty binding is invalid",
          500
        )
      existing.outcome = "UNKNOWN"
      existing.physicalOutstanding = true
      existing.usageId = undefined
      existing.usage = undefined
      existing.retainedResponse = undefined
      existing.receiptHash = record.hash
      existing.receipt = {
        sequence: record.sequence,
        hash: record.hash,
        signature: record.signature,
      }
      const grant = this.grants.get(existing.grantId)
      if (grant) grant.receiptHash = record.hash
      return
    }
    if (event.type === "legacy_request_uncertain") {
      const existing = this.requests.get(event.requestId)
      if (
        !existing ||
        existing.grantId !== event.grantId ||
        existing.attemptId !== event.attemptId ||
        existing.outcome !== "SUCCEEDED" ||
        (existing.usage && existing.retainedResponse)
      )
        throw new ProviderGatewayError(
          "JOURNAL_INTEGRITY",
          "legacy provider recovery binding is invalid",
          500
        )
      existing.outcome = "UNKNOWN"
      existing.physicalOutstanding = true
      existing.usageId = undefined
      existing.usage = undefined
      existing.retainedResponse = undefined
      existing.receiptHash = record.hash
      existing.receipt = {
        sequence: record.sequence,
        hash: record.hash,
        signature: record.signature,
      }
      return
    }
    const result = event.result
    const existing = this.requests.get(result.requestId)
    if (
      !existing ||
      existing.outcome !== "PENDING" ||
      result.grantId !== existing.grantId ||
      result.attemptId !== existing.attemptId
    )
      throw new ProviderGatewayError("JOURNAL_INTEGRITY", "provider result binding is invalid", 500)
    existing.outcome = result.outcome
    existing.physicalOutstanding = !(
      result.outcome === "SUCCEEDED" &&
      result.usage &&
      result.retainedResponse
    )
    existing.statusCode = result.statusCode
    existing.responseHash = result.responseHash
    existing.responseBytes = result.responseBytes
    existing.usageId = result.usageId
    existing.usage = result.usage
    existing.retainedResponse = result.retainedResponse
    existing.detail = result.detail
    existing.receiptHash = record.hash
    existing.receipt = { sequence: record.sequence, hash: record.hash, signature: record.signature }
    const grant = this.grants.get(existing.grantId)
    if (grant) grant.receiptHash = record.hash
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
