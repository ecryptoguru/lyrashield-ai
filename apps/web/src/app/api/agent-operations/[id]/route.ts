import { getOperationStatus, resolveOperationPrincipal } from "@lyrashield/db"
import { PERMISSIONS } from "@lyrashield/auth"
import { requirePermission } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"

export const dynamic = "force-dynamic"

/**
 * W3-08: the one operation-status/recovery contract over REST. The operation
 * must belong to the caller's workspace; a foreign or fabricated id resolves
 * to not found, never to another principal's result.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const { session } = await requirePermission(workspaceId, PERMISSIONS.agent.view)
    const status = await getOperationStatus(id, workspaceId, {
      ...resolveOperationPrincipal({
        connectionId: session.oauth?.connectionId,
        apiKeyId: session.apiKey?.keyId,
        userId: session.apiKey || session.oauth ? undefined : session.userId,
      }),
      authorizationVersion: session.oauth?.authorizationVersion,
    })
    if (!status) {
      return apiError("NOT_FOUND", "Operation not found in this workspace", 404)
    }
    return apiSuccess(status)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to read operation status", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to read operation status", 500)
  }
}
