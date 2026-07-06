import { denyApproval } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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
    const approval = await denyApproval(approvalId, workspaceId, session.userId)
    return apiSuccess(approval)
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      return apiError("NOT_FOUND", err.message, 404)
    }
    if (err instanceof Error && (err.message.includes("not pending") || err.message.includes("expired"))) {
      return apiError("CONFLICT", err.message, 409)
    }
    return authErrorResponse(err)
  }
}
