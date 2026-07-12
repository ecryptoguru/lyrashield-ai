import { updateNotificationStatus, prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { z } from "zod"

const PatchNotificationSchema = z.object({
  workspaceId: z.string().min(1),
  action: z.enum(["mark_read", "mark_sent", "update_status"]),
  status: z.enum(["pending", "sent", "read", "failed"]).optional(),
})

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = PatchNotificationSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, action } = parsed.data

    const perm =
      action === "mark_read" ? PERMISSIONS.notification.view : PERMISSIONS.notification.manage

    const { session } = await requirePermission(workspaceId, perm)

    let status: string
    switch (action) {
      case "mark_read":
        status = "read"
        break
      case "mark_sent":
        status = "sent"
        break
      case "update_status":
        status = parsed.data.status ?? "pending"
        break
    }

    const updated = await updateNotificationStatus(id, workspaceId, status)

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "notification.updated",
        resourceType: "notification",
        resourceId: id,
      },
    })

    return apiSuccess({ id: updated.id, status: updated.status })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to update notification", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update notification", 500)
  }
}
