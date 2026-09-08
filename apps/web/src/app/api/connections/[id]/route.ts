import { withCookieMutation } from "../../../../lib/api-auth"
import { getAgentConnection, revokeAgentConnection, prisma } from "@lyrashield/db"
import { requireWorkspaceAccess } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { requireBrowserConnectionManager } from "../connection-auth"

export const dynamic = "force-dynamic"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requireWorkspaceAccess(workspaceId, "DEVELOPER")
    const connection = await getAgentConnection(id, workspaceId)
    if (!connection) {
      return apiError("NOT_FOUND", "Agent connection not found", 404)
    }

    return apiSuccess(connection)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get agent connection", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get agent connection", 500)
  }
}

async function del(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const { session, connection: authorizedConnection } = await requireBrowserConnectionManager(
      workspaceId,
      id
    )
    if (!authorizedConnection) return apiError("NOT_FOUND", "Agent connection not found", 404)

    const connection = await revokeAgentConnection(id, workspaceId)
    if (!connection) {
      return apiError("NOT_FOUND", "Agent connection not found", 404)
    }

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "agent_connection.revoked",
        resourceType: "agent_connection",
        resourceId: id,
        metadata: { clientType: connection.clientType },
      },
    })

    return apiSuccess(connection)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to revoke agent connection", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to revoke agent connection", 500)
  }
}

export const DELETE = withCookieMutation(del)
