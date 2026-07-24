import { revokeApiKey, prisma } from "@lyrashield/db"
import { requireWorkspaceAccess } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"

/** Revoke a workspace API key. ADMIN+ browser session only; idempotence-safe CAS. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const { session } = await requireWorkspaceAccess(workspaceId, "ADMIN")
    if (session.apiKey) {
      return apiError("FORBIDDEN", "API keys cannot manage API keys", 403)
    }

    const revoked = await revokeApiKey(id, workspaceId)
    if (!revoked) {
      return apiError("NOT_FOUND", "API key not found or already revoked", 404)
    }

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "api_key.revoked",
        resourceType: "api_key",
        resourceId: id,
      },
    })

    return apiSuccess({ id, revoked: true })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to revoke API key", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to revoke API key", 500)
  }
}
