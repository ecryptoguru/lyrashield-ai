import { ApprovalMutationError, approveApproval } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: approvalId } = await params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const workspaceId = (body as { workspaceId?: string })?.workspaceId
  if (!workspaceId) {
    return apiError("VALIDATION_ERROR", "workspaceId is required", 400)
  }

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.agent.approve)
    const approval = await approveApproval(approvalId, workspaceId, session.userId)
    return apiSuccess(approval)
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
