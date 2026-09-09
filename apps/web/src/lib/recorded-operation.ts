import {
  claimOrGetAgentOperation,
  completeAgentOperation,
  failAgentOperation,
} from "@lyrashield/db"
import type { requirePermission } from "@lyrashield/auth/server"
import { apiError, apiSuccess } from "./api-response"
import { logger } from "@lyrashield/logger"

/** Call only after current permission, resource and delegated-scope checks. */
export async function recordedOperation(
  request: Request,
  params: {
    workspaceId: string
    operationName: string
    input: Record<string, unknown>
    session: Awaited<ReturnType<typeof requirePermission>>["session"]
  },
  execute: (outcome: { confirmNotSubmitted: () => void }) => Promise<Response>
): Promise<Response> {
  let confirmedNotSubmitted = false
  const outcome = {
    confirmNotSubmitted: () => {
      confirmedNotSubmitted = true
    },
  }
  const key = request.headers.get("idempotency-key")
  if (key === null) return execute(outcome)
  if (!key.trim() || key.length > 128)
    return apiError("VALIDATION_ERROR", "Idempotency-Key must be 1-128 characters", 400)
  const { session, ...identity } = params
  const claim = await claimOrGetAgentOperation({
    ...identity,
    idempotencyKey: key.trim(),
    connectionId: session.oauth?.connectionId,
    apiKeyId: session.apiKey?.keyId,
    userId: session.apiKey || session.oauth ? undefined : session.userId,
    authorizationVersion: session.oauth?.authorizationVersion,
  })
  if (claim.status === "CONFLICT") return apiError("IDEMPOTENCY_CONFLICT", claim.message, 409)
  const operationId = claim.operation.id
  if (claim.status === "REPLAY" && claim.operation.result) {
    return apiSuccess({ ...(claim.operation.result as Record<string, unknown>), operationId })
  }
  if (claim.status !== "NEW")
    return apiError(
      claim.status === "IN_PROGRESS" ? "OPERATION_IN_PROGRESS" : "OPERATION_UNAVAILABLE",
      "Inspect this operation before starting another request.",
      409,
      undefined,
      { operationId }
    )
  let completed = false
  try {
    const response = await execute(outcome)
    if (!response.ok) {
      const envelope = await response.clone().json()
      if (envelope.error) {
        envelope.error.details = { ...envelope.error.details, operationId }
        return Response.json(envelope, { status: response.status, headers: response.headers })
      }
      return response
    }
    const envelope = (await response.clone().json()) as { data: Record<string, unknown> }
    await completeAgentOperation(operationId, params.workspaceId, {
      result: envelope.data,
      resultReference: typeof envelope.data.id === "string" ? envelope.data.id : undefined,
    })
    completed = true
    return apiSuccess({ ...envelope.data, operationId }, response.status)
  } finally {
    // A handler may already have persisted work before returning an error.
    // Only a callback that positively confirms no submission may permit a fresh key.
    if (!completed)
      await failAgentOperation(operationId, params.workspaceId, {
        error: confirmedNotSubmitted ? "OPERATION_NOT_SUBMITTED" : "OPERATION_OUTCOME_UNKNOWN",
      }).catch((error) =>
        logger.error("Failed to record operation outcome", { operationId, error: String(error) })
      )
  }
}
