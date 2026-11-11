import { performance } from "node:perf_hooks"
import {
  providerGrantRevocationSchema,
  type JournalRecord,
  type ProviderGrant,
  type ProviderGrantRevocation,
  type ProviderGrantStatus,
} from "@lyrashield/runtime-control"
import type { TerminalUsage } from "./provider-usage"
import { type RetainedResponse } from "./retained-response"
import { ProviderGatewayError } from "./errors"
import { deliverReplay, type ProviderStreamSink } from "./downstream"
import { type ProviderJournalEvent, type GrantState, type RequestState } from "./journal-events"
import { abortable } from "./proxy-utils"
import {
  applyProviderJournalRecord,
  grantStatus,
  requestStatus,
  grantResponse,
  providerUsageId,
  responseIdentityReused,
} from "./journal-state"
import {
  prepareProxyRequest,
  prepareGrantIssue,
  authorizedPolicy,
  type ProxyRequestContext,
  type ProviderGatewayServiceOptions,
  type ProxyResponse,
  type DeliveryState,
  type ProxyInput,
  type InFlightRequest,
  type ReadyProxyRequest,
} from "./proxy-request"
import { readProviderResponse, prepareRetainedResponse } from "./proxy-response"

export { ProviderGatewayError } from "./errors"
export { providerJournalEventSchema } from "./journal-events"
export type { ProviderJournalEvent } from "./journal-events"
export type { ProviderGatewayServiceOptions } from "./proxy-request"

const MAX_OUTSTANDING_PROVIDER_REQUESTS = 8

export class ProviderGatewayService {
  private initialized: Promise<void> | null = null
  private serial: Promise<void> = Promise.resolve()
  private readonly grants = new Map<string, GrantState>()
  private readonly grantsByRequest = new Map<string, string>()
  private readonly requests = new Map<string, RequestState>()
  private readonly inFlight = new Map<string, InFlightRequest>()
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
      const grant = await prepareGrantIssue(
        {
          ...this.requestContext(),
          grantsByRequest: this.grantsByRequest,
        },
        input,
        () => this.now()
      )
      this.assertGrantActive(grant)
      return grantResponse(grant)
    })
  }

  async findGrantByRequest(grantRequestId: string): Promise<ProviderGrant | null> {
    await this.initialize()
    const grantId = this.grantsByRequest.get(grantRequestId)
    if (!grantId) return null
    const grant = this.grants.get(grantId)
    return grant ? grantResponse(grant) : null
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
    return requestStatus(request, grant)
  }

  private async prepareProxy(input: ProxyInput, delivery?: DeliveryState) {
    await this.initialize()
    return prepareProxyRequest(this.requestContext(delivery), input)
  }

  private requestContext(delivery?: DeliveryState): ProxyRequestContext {
    return {
      options: this.options,
      admissionClosed: this.failed || this.draining || this.options.admission !== "open",
      grants: this.grants,
      requests: this.requests,
      inFlight: this.inFlight,
      assertGrantActive: (grant) => this.assertGrantActive(grant),
      authorizedPolicy: (request, route) => authorizedPolicy(this.options, request, route),
      apply: (record) => this.apply(record),
      bindGrant: (grant) => {
        if (delivery) delivery.grantId = grant.grantId
      },
    }
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
      if (sink && this.requests.get(input.requestId)?.stream)
        return this.replayProxy(prepared, sink, delivery)
      return prepared.response
    }
    const { controller, policy, approved, grant } = prepared
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
      const upstream = await this.dispatchProxy(input, prepared, signal, deadlineAt)
      const responseHeaders: Record<string, string> = {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "x-lyra-request-id": input.requestId,
      }
      const { responseBody, usage, responseHash } = await readProviderResponse(
        upstream,
        policy,
        approved,
        signal,
        () => {
          controller.abort()
          return this.serialized(() =>
            this.recordResult(
              input.requestId,
              "UNKNOWN",
              upstream.status,
              undefined,
              undefined,
              "provider response or terminal usage is unavailable"
            )
          )
        },
        {
          deadlineAt,
          start: activeSink
            ? () =>
                this.deliverEffect(grant, signal, policy.idleTimeoutMs, deadlineAt, () =>
                  activeSink.start(upstream.status, responseHeaders)
                )
            : undefined,
          write: activeSink
            ? (chunk) =>
                this.deliverEffect(grant, signal, policy.idleTimeoutMs, deadlineAt, () =>
                  activeSink.write(chunk)
                )
            : undefined,
          complete: activeSink
            ? () =>
                this.deliverEffect(grant, signal, policy.idleTimeoutMs, deadlineAt, () =>
                  activeSink.complete()
                )
            : undefined,
        }
      )
      const result = await this.finalizeResponse(
        input.requestId,
        grant,
        signal,
        deadlineAt,
        upstream.status,
        responseHeaders,
        responseBody,
        responseHash,
        usage,
        !!activeSink
      )
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

  private async replayProxy(
    prepared: Extract<Awaited<ReturnType<typeof prepareProxyRequest>>, { kind: "replay" }>,
    sink: ProviderStreamSink,
    delivery?: DeliveryState
  ): Promise<ProxyResponse> {
    const { grant, response } = prepared
    const policy = grant.policy
    if (!policy || !delivery)
      throw new ProviderGatewayError("JOURNAL_INTEGRITY", "replay policy is unavailable", 500)
    const deadlineAt = performance.now() + policy.deadlineMs
    const timeout = setTimeout(
      () => delivery.controller.abort(),
      Math.min(
        policy.deadlineMs,
        Math.max(1, Date.parse(grant.request.expiresAt) - this.now().getTime())
      )
    )
    const signal = AbortSignal.any([sink.signal, delivery.controller.signal])
    try {
      await deliverReplay(response, sink, (effect) =>
        this.deliverEffect(grant, signal, policy.idleTimeoutMs, deadlineAt, effect)
      )
      return { ...response, streamed: true }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async finalizeResponse(
    requestId: string,
    grant: GrantState,
    signal: AbortSignal,
    deadlineAt: number,
    statusCode: number,
    responseHeaders: Record<string, string>,
    responseBody: Buffer,
    responseHash: string,
    usage: TerminalUsage | undefined,
    streamed: boolean
  ): Promise<RequestState> {
    return this.serialized(async () => {
      if (
        signal.aborted ||
        performance.now() >= deadlineAt ||
        grant.revokedAt ||
        Date.parse(grant.request.expiresAt) <= this.now().getTime()
      ) {
        await this.recordResult(
          requestId,
          "UNKNOWN",
          undefined,
          undefined,
          undefined,
          "provider request was aborted after revocation"
        )
        throw new ProviderGatewayError("PROVIDER_UNAVAILABLE", "provider outcome is unknown", 502)
      }
      const state = this.requests.get(requestId)
      if (!state) throw new ProviderGatewayError("JOURNAL_INTEGRITY", "request is missing", 500)
      if (
        usage &&
        responseIdentityReused(this.requests, this.options.signingSecret, state, usage)
      ) {
        await this.recordResult(
          requestId,
          "UNKNOWN",
          statusCode,
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
      const retainedResponse = prepareRetainedResponse(
        this.options.responseEncryptionSecret ?? "",
        this.options.signingSecret,
        state,
        { statusCode, headers: responseHeaders, body: responseBody },
        responseHash,
        usage,
        streamed
      )
      return this.recordResult(
        requestId,
        "SUCCEEDED",
        statusCode,
        responseHash,
        responseBody.byteLength,
        undefined,
        usage,
        retainedResponse
      )
    })
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

  private async dispatchProxy(
    input: ProxyInput,
    prepared: ReadyProxyRequest,
    signal: AbortSignal,
    deadlineAt: number
  ): Promise<Response> {
    const { target, headers, grant } = prepared
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
      } else if (request.outcome === "SUCCEEDED") {
        // A persisted completion cannot prove its acknowledgement survived.
        // Independent reconciliation is required before recovered replay/usage.
        const record = await this.options.journal.append({
          type: "recovered_completion_uncertain",
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
