import { withCookieMutation } from "../../../../../lib/api-auth"
import {
  ApprovalMutationError,
  approveApproval,
  getApproval,
  verifyInputHash,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"

async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: approvalId } = await params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const typedBody = body as { workspaceId?: string; input?: Record<string, unknown> }
  const workspaceId = typedBody?.workspaceId
  const input = typedBody?.input
  if (!workspaceId) {
    return apiError("VALIDATION_ERROR", "workspaceId is required", 400)
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return apiError("VALIDATION_ERROR", "input is required and must be an object", 400)
  }

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.agent.approve)

    const approval = await getApproval(approvalId, workspaceId)
    if (!approval) {
      return apiError("NOT_FOUND", "Approval not found", 404)
    }

    if (!verifyInputHash(approval.actionName, input, approval.inputHash)) {
      return apiError(
        "INPUT_HASH_MISMATCH",
        "Submitted input does not match the requested action",
        422
      )
    }

    const updated = await approveApproval(approvalId, workspaceId, session.userId)
    return apiSuccess(updated)
  } catch (err) {
    if (err instanceof ApprovalMutationError && err.code === "NOT_FOUND") {
      return apiError("NOT_FOUND", err.message, 404)
    }
    if (err instanceof ApprovalMutationError) {
      return apiError("CONFLICT", err.message, 409)
    }
    const authErr = authErrorResponse(err)
    if (authErr) return authErr
    // Fallback for non-auth errors — authErrorResponse returns null otherwise,
    // which is not a valid Response. (Q7)
    logger.error("Failed to approve agent action", { error: String(err) })
    return apiError("INTERNAL_ERROR", "Failed to approve agent action", 500)
  }
}

export const POST = withCookieMutation(post)
