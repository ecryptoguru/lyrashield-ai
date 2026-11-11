import {
  canonicalJson,
  providerGrantRequestSchema,
  type JournalPort,
  sha256Hex,
  type JournalRecord,
  type ProviderGrantRequest,
} from "@lyrashield/runtime-control"
import type { ProviderRoute } from "./config"
import type { GrantState, ProviderJournalEvent, RequestState } from "./journal-events"
import { ProviderGatewayError } from "./errors"
import { verifyToken, grantIdFor } from "./grant-tokens"
import {
  authorizeRequest,
  policyDigest,
  requestPolicySchema,
  type RequestPolicy,
} from "./request-policy"
import { replayResponse } from "./retained-response"
import { responseBinding } from "./proxy-response"
import { resolveProviderUrl, normalizeHeaderValue } from "./proxy-utils"

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

export interface ProxyResponse {
  statusCode: number
  headers: Record<string, string>
  body: Buffer
  replayed: boolean
  streamed?: true
}
export interface DeliveryState {
  grantId?: string
  controller: AbortController
  done: Promise<void>
  finish: () => void
}

const MAX_UPSTREAM_BODY_BYTES = 4 * 1024 * 1024
const MAX_OUTSTANDING_PROVIDER_REQUESTS = 8

export interface ProxyInput {
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
export interface InFlightRequest {
  grantId: string
  controller: AbortController
  done: Promise<void>
  finish: () => void
}
export interface ProxyRequestContext {
  options: ProviderGatewayServiceOptions
  admissionClosed: boolean
  bindGrant?: (grant: GrantState) => void
  grants: ReadonlyMap<string, GrantState>
  requests: ReadonlyMap<string, RequestState>
  inFlight: Map<string, InFlightRequest>
  assertGrantActive: (grant: GrantState) => void
  authorizedPolicy: (request: ProviderGrantRequest, route: ProviderRoute) => Promise<RequestPolicy>
  apply: (record: JournalRecord<ProviderJournalEvent>) => void
}

async function replayRequest(
  context: ProxyRequestContext,
  grant: GrantState,
  route: ProviderRoute,
  existing: RequestState,
  identity: { target: URL; method: string; contentType: string; accept: string; bodyHash: string }
) {
  const { target, method, contentType, accept, bodyHash } = identity
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
  const policy = await context.authorizedPolicy(grant.request, route)
  if (!grant.policy || policyDigest(policy) !== policyDigest(grant.policy))
    throw new ProviderGatewayError(
      "POLICY_CHANGED",
      "provider grant requires renewed broker authorization"
    )
  if (
    (existing.outcome === "SUCCEEDED" || existing.outcome === "FAILED") &&
    existing.retainedResponse &&
    context.options.responseEncryptionSecret
  ) {
    const response = replayResponse(
      context.options.responseEncryptionSecret,
      responseBinding(existing),
      existing.retainedResponse,
      existing
    )
    context.assertGrantActive(grant)
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

export async function prepareProxyRequest(context: ProxyRequestContext, input: ProxyInput) {
  if (context.admissionClosed || context.options.admission !== "open")
    throw new ProviderGatewayError("ADMISSION_CLOSED", "runtime admission is closed")
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/.test(input.requestId)) {
    throw new ProviderGatewayError("INVALID_REQUEST_ID", "request identity is invalid", 400)
  }
  const route = context.options.providers.get(input.providerId)
  if (!route) throw new ProviderGatewayError("PROVIDER_NOT_ALLOWED", "provider is not configured")
  const token = input.authorization.startsWith("Bearer ")
    ? input.authorization.slice("Bearer ".length)
    : ""
  const verified = verifyToken(context.options.signingSecret, token)
  const grant = context.grants.get(verified.grantId)
  if (!grant) throw new ProviderGatewayError("GRANT_NOT_FOUND", "provider grant not found")
  context.bindGrant?.(grant)
  if (
    (input.scanId !== undefined && grant.request.scanId !== input.scanId) ||
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
  context.assertGrantActive(grant)
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
  const existing = context.requests.get(input.requestId)
  if (existing)
    return replayRequest(context, grant, route, existing, {
      target,
      method,
      contentType,
      accept,
      bodyHash,
    })
  const policy = await context.authorizedPolicy(grant.request, route)
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
  context.assertGrantActive(grant)
  const outstanding = [...context.requests.values()].filter(
    (request) => request.physicalOutstanding
  )
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
  const startRecord = await context.options.journal.append({
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
  context.apply(startRecord)
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
  context.inFlight.set(input.requestId, { grantId: grant.grantId, controller, done, finish })
  return { kind: "ready" as const, target, headers, controller, policy, approved, grant }
}

export type ReadyProxyRequest = Extract<
  Awaited<ReturnType<typeof prepareProxyRequest>>,
  { kind: "ready" }
>

export async function prepareGrantIssue(
  context: ProxyRequestContext & { grantsByRequest: ReadonlyMap<string, string> },
  input: unknown,
  now: () => Date
): Promise<GrantState> {
  const parsed = providerGrantRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw new ProviderGatewayError(
      "INVALID_GRANT_REQUEST",
      "provider grant request is invalid",
      400
    )
  }
  const request = parsed.data
  if (context.admissionClosed)
    throw new ProviderGatewayError("ADMISSION_CLOSED", "runtime admission is closed")
  const route = context.options.providers.get(request.providerId)
  if (!route) throw new ProviderGatewayError("PROVIDER_NOT_ALLOWED", "provider is not configured")
  if (Date.parse(request.expiresAt) <= now().getTime()) {
    throw new ProviderGatewayError("GRANT_EXPIRED", "provider grant expiry is not in the future")
  }
  if (Date.parse(request.expiresAt) - now().getTime() > 86_400_000)
    throw new ProviderGatewayError(
      "INVALID_GRANT_EXPIRY",
      "provider grant lifetime exceeds one day",
      400
    )
  const existingId = context.grantsByRequest.get(request.grantRequestId)
  if (existingId) {
    const existing = context.grants.get(existingId)
    if (!existing)
      throw new ProviderGatewayError("JOURNAL_INTEGRITY", "grant index is corrupt", 500)
    if (canonicalJson(existing.request) !== canonicalJson(request)) {
      throw new ProviderGatewayError(
        "IDEMPOTENCY_CONFLICT",
        "grant request id was reused with different input"
      )
    }
    const policy = await context.authorizedPolicy(existing.request, route)
    if (!existing.policy || policyDigest(policy) !== policyDigest(existing.policy))
      throw new ProviderGatewayError(
        "POLICY_CHANGED",
        "provider grant requires renewed broker authorization"
      )
    context.assertGrantActive(existing)
    return existing
  }
  const policy = await context.authorizedPolicy(request, route)
  if (Date.parse(request.expiresAt) <= now().getTime())
    throw new ProviderGatewayError("GRANT_EXPIRED", "provider grant is expired")
  const grantId = grantIdFor(request)
  const record = await context.options.journal.append({
    type: "grant_issued",
    grant: { grantRequestId: request.grantRequestId, grantId, request, policy },
  })
  context.apply(record)
  const grant = context.grants.get(grantId)
  if (!grant)
    throw new ProviderGatewayError("JOURNAL_INTEGRITY", "issued grant was not reconstructed", 500)
  return grant
}

export async function authorizedPolicy(
  options: ProviderGatewayServiceOptions,
  request: ProviderGrantRequest,
  route: ProviderRoute
): Promise<RequestPolicy> {
  if (
    !options.authorizeGrant ||
    !route.requestPolicy ||
    !options.responseEncryptionSecret ||
    Buffer.byteLength(options.responseEncryptionSecret) < 32
  )
    throw new ProviderGatewayError(
      "BROKER_AUTHORIZATION_REQUIRED",
      "trusted broker policy and encrypted retention are required"
    )
  const policy = requestPolicySchema.parse(await options.authorizeGrant(request))
  if (policyDigest(policy) !== policyDigest(requestPolicySchema.parse(route.requestPolicy)))
    throw new ProviderGatewayError(
      "POLICY_DENIED",
      "broker policy does not match the server-approved adapter"
    )
  return policy
}
