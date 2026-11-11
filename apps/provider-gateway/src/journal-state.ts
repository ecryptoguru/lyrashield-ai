import { createHmac } from "node:crypto"
import {
  canonicalJson,
  providerGrantStatusSchema,
  type JournalRecord,
  type ProviderGrantStatus,
  type ProviderGrant,
} from "@lyrashield/runtime-control"
import { signToken } from "./grant-tokens"
import { policyDigest } from "./request-policy"
import { ProviderGatewayError } from "./errors"
import type { GrantState, RequestState, ProviderJournalEvent } from "./journal-events"
import type { TerminalUsage } from "./provider-usage"

export interface ProviderJournalState {
  grants: Map<string, GrantState>
  grantsByRequest: Map<string, string>
  requests: Map<string, RequestState>
}

export function grantStatus(grant: GrantState): ProviderGrantStatus {
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

export function providerUsageId(
  signingSecret: string,
  state: RequestState,
  usage: TerminalUsage
): string {
  return `usage_${createHmac("sha256", signingSecret)
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

export function providerResponseIdentity(
  signingSecret: string,
  providerId: string,
  providerResponseId: string
): string {
  return createHmac("sha256", signingSecret)
    .update(canonicalJson({ version: 1, providerId, providerResponseId }))
    .digest("hex")
}

export function responseIdentityReused(
  requests: ReadonlyMap<string, RequestState>,
  signingSecret: string,
  state: RequestState,
  usage: TerminalUsage
): boolean {
  const identity = providerResponseIdentity(
    signingSecret,
    state.providerId,
    usage.providerResponseId
  )
  return [...requests.values()].some(
    (request) =>
      request.requestId !== state.requestId && request.observedResponseIdentity === identity
  )
}

export function applyProviderJournalRecord(
  state: ProviderJournalState,
  signingSecret: string,
  record: JournalRecord<ProviderJournalEvent>
): void {
  const event = record.payload
  if (event.type === "grant_issued") {
    state.grants.set(event.grant.grantId, {
      request: event.grant.request,
      policy: event.grant.policy,
      grantId: event.grant.grantId,
      token: signToken(
        signingSecret,
        event.grant.request,
        event.grant.grantId,
        event.grant.policy ? policyDigest(event.grant.policy) : null
      ),
      revokedAt: null,
      requestCount: 0,
      reservedCostMicros: 0,
      receiptHash: record.hash,
    })
    state.grantsByRequest.set(event.grant.grantRequestId, event.grant.grantId)
    return
  }
  if (event.type === "grant_revoked") {
    const grant = state.grants.get(event.revocation.grantId)
    if (grant) {
      grant.revokedAt = event.revocation.revokedAt
      grant.receiptHash = record.hash
    }
    return
  }
  if (event.type === "request_started") {
    const request = event.request
    state.requests.set(request.requestId, {
      ...request,
      outcome: "PENDING",
      physicalOutstanding: true,
      receiptHash: record.hash,
      receipt: { sequence: record.sequence, hash: record.hash, signature: record.signature },
    })
    const grant = state.grants.get(request.grantId)
    if (grant) {
      grant.requestCount += 1
      grant.reservedCostMicros += request.reservationMicros
      grant.receiptHash = record.hash
    }
    return
  }
  if (event.type === "stream_delivery_uncertain") {
    const existing = state.requests.get(event.requestId)
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
    const grant = state.grants.get(existing.grantId)
    if (grant) grant.receiptHash = record.hash
    return
  }
  if (
    event.type === "legacy_request_uncertain" ||
    event.type === "recovered_completion_uncertain"
  ) {
    const existing = state.requests.get(event.requestId)
    if (
      !existing ||
      existing.grantId !== event.grantId ||
      existing.attemptId !== event.attemptId ||
      existing.outcome !== "SUCCEEDED" ||
      (event.type === "legacy_request_uncertain" && existing.usage && existing.retainedResponse)
    )
      throw new ProviderGatewayError(
        "JOURNAL_INTEGRITY",
        "provider recovery uncertainty binding is invalid",
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
    const grant = state.grants.get(existing.grantId)
    if (grant) grant.receiptHash = record.hash
    return
  }
  const result = event.result
  const existing = state.requests.get(result.requestId)
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
  if (result.usage)
    existing.observedResponseIdentity = providerResponseIdentity(
      signingSecret,
      existing.providerId,
      result.usage.providerResponseId
    )
  existing.retainedResponse = result.retainedResponse
  existing.detail = result.detail
  existing.receiptHash = record.hash
  existing.receipt = { sequence: record.sequence, hash: record.hash, signature: record.signature }
  const grant = state.grants.get(existing.grantId)
  if (grant) grant.receiptHash = record.hash
}

export function grantResponse(grant: GrantState): ProviderGrant {
  return {
    grantId: grant.grantId,
    token: grant.token,
    attemptId: grant.request.attemptId,
    providerId: grant.request.providerId,
    expiresAt: grant.request.expiresAt,
    receipt: grant.receiptHash,
  }
}

export function requestStatus(request: RequestState, grant: GrantState) {
  return {
    version: 1 as const,
    requestId: request.requestId,
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
