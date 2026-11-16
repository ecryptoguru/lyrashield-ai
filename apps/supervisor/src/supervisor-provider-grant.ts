import {
  providerGrantSchema,
  type ProviderGrant,
  type ProviderGrantRequest,
} from "@lyrashield/runtime-control"
import type { AttemptState } from "./journal-events"
import type { SupervisorOperationsContext } from "./supervisor-operations"
import { RuntimeControlError } from "./service-common"

export async function ensureProviderGrant(
  ctx: SupervisorOperationsContext,
  attempt: AttemptState,
  grantRequestId: string
): Promise<ProviderGrant> {
  const policy = attempt.provider
  if (!policy)
    throw new RuntimeControlError("PROVIDER_POLICY_REQUIRED", "provider policy is missing", 400)
  const request: ProviderGrantRequest = {
    grantRequestId,
    attemptId: attempt.binding.attemptId,
    scanId: attempt.binding.scanId,
    workspaceId: attempt.binding.workspaceId,
    operationId: attempt.binding.operationId,
    authorityEpochId: attempt.binding.authorityEpochId,
    authorityRevision: attempt.binding.authorityRevision,
    expiresAt: attempt.binding.expiresAt,
    providerId: policy.providerId,
    maxRequests: policy.maxRequests,
    costReservationMicros: policy.costReservationMicros,
    maxReservedCostMicros: policy.maxReservedCostMicros,
  }
  const existing = attempt.grants.get(policy.providerId)
  if (existing && !existing.revoked) {
    const origin = existing.grantRequestId
      ? ctx.commands.get(existing.grantRequestId)?.request
      : undefined
    if (origin?.type !== "START_PAID" || origin.attemptId !== attempt.binding.attemptId)
      throw new RuntimeControlError("GRANT_BINDING_MISMATCH", "provider grant origin is missing")
    const recovered = providerGrantSchema.safeParse(
      await ctx.options.providerGateway.findGrantByRequest(origin.commandId)
    )
    if (
      !recovered.success ||
      recovered.data.grantId !== existing.grantId ||
      recovered.data.attemptId !== attempt.binding.attemptId ||
      recovered.data.providerId !== policy.providerId ||
      recovered.data.expiresAt !== attempt.binding.expiresAt
    )
      throw new RuntimeControlError("GRANT_BINDING_MISMATCH", "provider grant recovery failed")
    return recovered.data
  }
  if (existing)
    throw new RuntimeControlError("GRANT_BINDING_MISMATCH", "provider grant was revoked")
  const received = providerGrantSchema.safeParse(
    await ctx.options.providerGateway.issueGrant(request)
  )
  if (
    !received.success ||
    received.data.attemptId !== attempt.binding.attemptId ||
    received.data.providerId !== policy.providerId ||
    received.data.expiresAt !== attempt.binding.expiresAt
  ) {
    throw new RuntimeControlError(
      "GRANT_BINDING_MISMATCH",
      "provider gateway returned a foreign grant"
    )
  }
  const grant = received.data
  const record = await ctx.options.journal.append({
    type: "provider_grants_bound",
    supervisorInstanceId: ctx.options.supervisorInstanceId,
    observedAt: ctx.nowIso(),
    commandId: grantRequestId,
    attemptId: attempt.binding.attemptId,
    grants: [{ providerId: grant.providerId, grantId: grant.grantId, revoked: false }],
  })
  ctx.apply(record)
  return grant
}
