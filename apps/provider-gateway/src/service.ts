import {
  canonicalJson,
  providerGrantRequestSchema,
  providerGrantRevocationSchema,
  providerGrantStatusSchema,
  sha256Hex,
  type JournalPort,
  type JournalRecord,
  type ProviderGrant,
  type ProviderGrantRevocation,
  type ProviderGrantStatus,
} from "@lyrashield/runtime-control"
import type { ProviderRoute } from "./config"
import { ProviderGatewayError } from "./errors"
import { grantIdFor, signToken, verifyToken } from "./grant-tokens"
import { type ProviderJournalEvent, type GrantState, type RequestState } from "./journal-events"
import {
  abortable,
  readBoundedResponse,
  resolveProviderUrl,
  normalizeHeaderValue,
} from "./proxy-utils"

export { ProviderGatewayError } from "./errors"
export { providerJournalEventSchema } from "./journal-events"
export type { ProviderJournalEvent } from "./journal-events"

const MAX_UPSTREAM_BODY_BYTES = 4 * 1024 * 1024

export interface ProviderGatewayServiceOptions {
  journal: JournalPort<ProviderJournalEvent>
  signingSecret: string
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

  constructor(private readonly options: ProviderGatewayServiceOptions) {
    if (Buffer.byteLength(options.signingSecret, "utf8") < 32) {
      throw new Error("provider gateway signing secret must be at least 32 bytes")
    }
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
      if (this.draining || this.options.admission !== "open")
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
        return this.grantResponse(existing)
      }
      const grantId = grantIdFor(request)
      const record = await this.options.journal.append({
        type: "grant_issued",
        grant: { grantRequestId: request.grantRequestId, grantId, request },
      })
      this.apply(record)
      const grant = this.grants.get(grantId)
      if (!grant)
        throw new ProviderGatewayError(
          "JOURNAL_INTEGRITY",
          "issued grant was not reconstructed",
          500
        )
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

  private async prepareProxy(input: ProxyInput) {
    await this.initialize()
    if (this.draining || this.options.admission !== "open")
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
    if (
      grant.request.providerId !== input.providerId ||
      grant.request.attemptId !== verified.attemptId
    ) {
      throw new ProviderGatewayError(
        "GRANT_BINDING_MISMATCH",
        "provider grant binding does not match the request"
      )
    }
    if (grant.revokedAt)
      throw new ProviderGatewayError("GRANT_REVOKED", "provider grant is revoked")
    if (Date.parse(grant.request.expiresAt) <= this.now().getTime()) {
      throw new ProviderGatewayError("GRANT_EXPIRED", "provider grant is expired")
    }
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
      if (existing.outcome === "SUCCEEDED") {
        return {
          kind: "replay" as const,
          response: {
            statusCode: existing.statusCode ?? 200,
            headers: { "x-lyra-request-id": input.requestId, "x-lyra-replayed": "true" },
            body: Buffer.from(
              JSON.stringify({ requestId: input.requestId, usageId: existing.usageId }),
              "utf8"
            ),
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
    if (grant.requestCount >= grant.request.maxRequests) {
      throw new ProviderGatewayError(
        "GRANT_REQUEST_BUDGET_EXHAUSTED",
        "provider grant request budget is exhausted"
      )
    }
    if (
      grant.reservedCostMicros + grant.request.costReservationMicros >
      grant.request.maxReservedCostMicros
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
        reservationMicros: grant.request.costReservationMicros,
      },
    })
    this.apply(startRecord)
    const headers: Record<string, string> = {
      accept: input.accept ?? "application/json",
      "x-lyra-request-id": input.requestId,
    }
    if (input.contentType) headers["content-type"] = input.contentType
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
    return { kind: "ready" as const, target, headers, controller }
  }

  async proxy(input: ProxyInput): Promise<ProxyResponse> {
    const prepared = await this.serialized(() => this.prepareProxy(input))
    if (prepared.kind === "replay") return prepared.response
    const { target, headers, controller } = prepared
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    try {
      let upstream: Response
      try {
        if (controller.signal.aborted) throw new Error("grant revoked before dispatch")
        upstream = await abortable(
          (this.options.fetchImpl ?? fetch)(target, {
            method: input.method,
            headers,
            body: input.body.byteLength > 0 ? input.body : undefined,
            redirect: "error",
            signal,
          }),
          signal
        )
      } catch {
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
        throw new ProviderGatewayError("PROVIDER_UNAVAILABLE", "provider outcome is unknown", 502)
      }
      let responseBody: Buffer
      try {
        responseBody = await abortable(
          readBoundedResponse(upstream, MAX_UPSTREAM_BODY_BYTES),
          signal
        )
      } catch {
        await this.serialized(() =>
          this.recordResult(
            input.requestId,
            "UNKNOWN",
            upstream.status,
            undefined,
            undefined,
            "provider response unavailable or exceeded the byte cap"
          )
        )
        throw new ProviderGatewayError(
          "PROVIDER_RESPONSE_UNKNOWN",
          "provider response exceeded the byte cap",
          502
        )
      }
      const outcome = upstream.ok ? "SUCCEEDED" : "FAILED"
      const responseHash = sha256Hex(responseBody.toString("base64"))
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
        return this.recordResult(
          input.requestId,
          outcome,
          upstream.status,
          responseHash,
          responseBody.byteLength
        )
      })
      const responseHeaders: Record<string, string> = {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "x-lyra-request-id": input.requestId,
      }
      if (result.usageId) responseHeaders["x-lyra-usage-id"] = result.usageId
      return {
        statusCode: upstream.status,
        headers: responseHeaders,
        body: responseBody,
        replayed: false,
      }
    } finally {
      this.inFlight.get(input.requestId)?.finish()
      this.inFlight.delete(input.requestId)
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
    detail?: string
  ): Promise<RequestState> {
    const usageId =
      responseHash === undefined
        ? undefined
        : `usage_${sha256Hex(`${requestId}\0${responseHash}`).slice(0, 40)}`
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
        grantId: event.grant.grantId,
        token: signToken(this.options.signingSecret, event.grant.request, event.grant.grantId),
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
        receiptHash: record.hash,
      })
      const grant = this.grants.get(request.grantId)
      if (grant) {
        grant.requestCount += 1
        grant.reservedCostMicros += request.reservationMicros
        grant.receiptHash = record.hash
      }
      return
    }
    const result = event.result
    const existing = this.requests.get(result.requestId)
    if (!existing) return
    existing.outcome = result.outcome
    existing.statusCode = result.statusCode
    existing.responseHash = result.responseHash
    existing.responseBytes = result.responseBytes
    existing.usageId = result.usageId
    existing.detail = result.detail
    existing.receiptHash = record.hash
    const grant = this.grants.get(existing.grantId)
    if (grant) grant.receiptHash = record.hash
  }

  private async load(): Promise<void> {
    const records = await this.options.journal.load()
    for (const record of records) this.apply(record)
    for (const request of this.requests.values()) {
      if (request.outcome === "PENDING") {
        request.outcome = "UNKNOWN"
        request.detail = "provider gateway restarted with an unresolved request"
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
        rejectResult(error)
      }
    })
    this.serial = run.catch(() => undefined)
    await run
    return result
  }
}
