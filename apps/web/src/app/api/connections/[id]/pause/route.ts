import { withCookieMutation } from "../../../../../lib/api-auth"
import { pauseAgentConnection, prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { requireBrowserConnectionManager } from "../../connection-auth"
import { z } from "zod"

export const dynamic = "force-dynamic"

const PauseSchema = z.object({
  workspaceId: z.string().min(1),
})

async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body: unknown = await request.json().catch(() => null)
    const parsed = PauseSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId } = parsed.data

    const { session, connection: authorizedConnection } = await requireBrowserConnectionManager(
      workspaceId,
      id
    )
    if (!authorizedConnection) return apiError("NOT_FOUND", "Agent connection not found", 404)

    const connection = await pauseAgentConnection(id, workspaceId)
    if (!connection) {
      return apiError("NOT_FOUND", "Agent connection not found or already revoked", 404)
    }

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "agent_connection.paused",
        resourceType: "agent_connection",
        resourceId: id,
        metadata: { clientType: connection.clientType },
      },
    })

    return apiSuccess(connection)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to pause agent connection", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to pause agent connection", 500)
  }
}

export const POST = withCookieMutation(post)
