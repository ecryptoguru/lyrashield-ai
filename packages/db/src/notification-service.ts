import { prisma } from "./client"
import type { Notification } from "./generated/prisma"
import { logger } from "@lyrashield/logger"

export async function createNotification(params: {
  workspaceId: string
  userId?: string
  channel: string
  type: string
  title: string
  body: string
  metadata?: Record<string, unknown>
}): Promise<Notification> {
  const notification = await prisma.notification.create({
    data: {
      workspaceId: params.workspaceId,
      ...(params.userId ? { userId: params.userId } : {}),
      channel: params.channel,
      type: params.type,
      title: params.title,
      body: params.body,
      status: "pending",
      ...(params.metadata ? { metadata: params.metadata } : {}),
    },
  })

  logger.info("Notification created", {
    workspaceId: params.workspaceId,
    notificationId: notification.id,
    type: params.type,
    channel: params.channel,
  })

  return notification
}

export async function getNotification(
  notificationId: string,
  workspaceId: string
): Promise<Notification | null> {
  return prisma.notification.findFirst({
    where: { id: notificationId, workspaceId, deletedAt: null },
  })
}

export async function listNotifications(params: {
  workspaceId: string
  userId?: string
  status?: string
  type?: string
  cursor?: string
  limit?: number
}): Promise<{ items: Notification[]; nextCursor: string | null }> {
  const limit = Math.min(params.limit ?? 20, 50)

  const notifications = await prisma.notification.findMany({
    where: {
      workspaceId: params.workspaceId,
      deletedAt: null,
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.type ? { type: params.type } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  })

  const nextCursor = notifications.length > limit ? (notifications[limit]?.id ?? null) : null
  const items = notifications.slice(0, limit)

  return { items, nextCursor }
}

export async function markNotificationSent(
  notificationId: string,
  workspaceId: string
): Promise<Notification> {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, workspaceId, deletedAt: null },
  })

  if (!notification) {
    throw new Error(`Notification not found: ${notificationId}`)
  }

  return prisma.notification.update({
    where: { id: notificationId },
    data: { status: "sent", sentAt: new Date() },
  })
}

export async function markNotificationRead(
  notificationId: string,
  workspaceId: string
): Promise<Notification> {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, workspaceId, deletedAt: null },
  })

  if (!notification) {
    throw new Error(`Notification not found: ${notificationId}`)
  }

  return prisma.notification.update({
    where: { id: notificationId },
    data: { status: "read" },
  })
}

const VALID_STATUSES = ["pending", "sent", "read", "failed"] as const

export async function updateNotificationStatus(
  notificationId: string,
  workspaceId: string,
  status: string,
  // When set, restrict the update to notifications addressed to this user (or
  // workspace-wide notifications with no recipient). Prevents a member from
  // mutating another member's personal notification via a shared workspace
  // permission (IDOR). Omit only for admin/system-level status changes.
  recipientUserId?: string
): Promise<Notification> {
  if (!VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
    throw new Error(`Invalid notification status: ${status}`)
  }

  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      workspaceId,
      deletedAt: null,
      ...(recipientUserId ? { OR: [{ userId: recipientUserId }, { userId: null }] } : {}),
    },
  })

  if (!notification) {
    throw new Error(`Notification not found: ${notificationId}`)
  }

  return prisma.notification.update({
    where: { id: notificationId },
    data: {
      status,
      ...(status === "sent" ? { sentAt: new Date() } : {}),
    },
  })
}

const DEFAULT_CHANNELS = ["in_app", "slack", "discord"] as const

export async function createAndSendNotification(params: {
  workspaceId: string
  type: string
  title: string
  body: string
  workspaceName?: string
  channels?: readonly string[]
  sendFn: (
    channel: string,
    payload: { type: string; title: string; body: string; workspaceName?: string }
  ) => Promise<boolean>
}): Promise<void> {
  const channels = params.channels ?? DEFAULT_CHANNELS

  for (const channel of channels) {
    const notification = await createNotification({
      workspaceId: params.workspaceId,
      channel,
      type: params.type,
      title: params.title,
      body: params.body,
    })

    const sent = await params.sendFn(channel, {
      type: params.type,
      title: params.title,
      body: params.body,
      workspaceName: params.workspaceName,
    })

    if (sent) {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "sent", sentAt: new Date() },
      })
    } else {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { status: "failed" },
      })
    }
  }
}
