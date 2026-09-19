import { withCookieMutation } from "../../../../../../lib/api-auth"
import { prisma, setConnectorConnectionStatus } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../../lib/api-response"
import { z } from "zod"

export const dynamic = "force-dynamic"

const DisableSchema = z.object({
  workspaceId: z.string().min(1),
  reason: z.string().trim().min(1).max(500).optional(),
})

/**
 * Disable a connector connection without deleting the row. Execution-time
 * checks re-read status on every invocation, so disabling takes effect
 * immediately and in-flight scans fail closed with the recorded reason. The
 * row (and its idempotent operation identity) is preserved — reconnecting
 * revives it in place.
 */
async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body: unknown = await request.json().catch(() => null)
    const parsed = DisableSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", "workspaceId is required", 400)
    }
    const { workspaceId, reason } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.integration.manage)

    const connection = await setConnectorConnectionStatus({
      workspaceId,
      integrationId: id,
      status: "disabled",
      reason: reason ?? "disabled_by_user",
    })
    if (!connection) {
      return apiError("NOT_FOUND", "Connector connection not found", 404)
    }

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "integration.connector.disabled",
        resourceType: "integration",
        resourceId: id,
        metadata: { reason: reason ?? "disabled_by_user" },
      },
    })

    return apiSuccess({ id: connection.id, status: connection.status })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to disable connector connection", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to disable connector connection", 500)
  }
}

export const POST = withCookieMutation(post)
