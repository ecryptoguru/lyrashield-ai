import {
  listNotifications,
  createNotification,
  markAllNotificationsRead,
  prisma,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import {
  apiError,
  apiSuccess,
  apiPaginated,
  parsePaginationParams,
} from "../../../lib/api-response"
import { z } from "zod"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const status = searchParams.get("status")
    const type = searchParams.get("type")
    const userId = searchParams.get("userId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.notification.view)

    const { cursor, limit } = parsePaginationParams(searchParams)

    const result = await listNotifications({
      workspaceId,
      ...(userId ? { userId } : {}),
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    })

    return apiPaginated(result.items, result.nextCursor)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list notifications", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list notifications", 500)
  }
}

const CreateNotificationSchema = z.object({
  workspaceId: z.string().min(1),
  channel: z.enum(["email", "slack", "discord", "in_app"]).default("in_app"),
  type: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const parsed = CreateNotificationSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, channel, type, title, body: notifBody, metadata } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.notification.manage)

    const notification = await createNotification({
      workspaceId,
      userId: session.userId,
      channel,
      type,
      title,
      body: notifBody,
      ...(metadata ? { metadata } : {}),
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "notification.created",
        resourceType: "notification",
        resourceId: notification.id,
      },
    })

    return apiSuccess(notification, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create notification", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create notification", 500)
  }
}

const MarkAllReadSchema = z.object({
  workspaceId: z.string().min(1),
  action: z.literal("mark_all_read"),
})

export async function PATCH(request: Request) {
  try {
    const parsed = MarkAllReadSchema.safeParse(await request.json())
    if (!parsed.success) return apiError("INVALID_PARAM", "Invalid mark-all-read request", 400)
    const { session } = await requirePermission(
      parsed.data.workspaceId,
      PERMISSIONS.notification.view
    )
    const count = await markAllNotificationsRead(parsed.data.workspaceId, session.userId)
    await prisma.auditLog.create({
      data: {
        workspaceId: parsed.data.workspaceId,
        actorUserId: session.userId,
        action: "notification.mark_all_read",
        resourceType: "notification",
        metadata: { count },
      },
    })
    return apiSuccess({ count })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to mark all notifications read", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to mark all notifications read", 500)
  }
}
