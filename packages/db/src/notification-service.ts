import { createHash } from "node:crypto"
import { prisma } from "./client"
import { Prisma } from "./generated/prisma"
import type { Notification } from "./generated/prisma"
import { logger } from "@lyrashield/logger"

export function computeNotificationDedupeKey(input: {
  workspaceId: string
  type: string
  title: string
  body: string
  dedupeKey?: string
}): string {
  if (input.dedupeKey) return input.dedupeKey
  return createHash("sha256")
    .update(`${input.workspaceId}:${input.type}:${input.title}:${input.body}`)
    .digest("hex")
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

export async function createNotification(params: {
  workspaceId: string
  userId?: string
  channel: string
  type: string
  title: string
  body: string
  metadata?: Record<string, unknown>
  dedupeKey?: string
}): Promise<Notification> {
  const dedupeKey = computeNotificationDedupeKey({
    workspaceId: params.workspaceId,
    type: params.type,
    title: params.title,
    body: params.body,
    dedupeKey: params.dedupeKey,
  })
  try {
    const notification = await prisma.notification.create({
      data: {
        workspaceId: params.workspaceId,
        ...(params.userId ? { userId: params.userId } : {}),
        channel: params.channel,
        type: params.type,
        title: params.title,
        body: params.body,
        status: "pending",
        dedupeKey,
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
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await prisma.notification.findFirst({
        where: { channel: params.channel, dedupeKey },
      })
      if (existing) {
        // retry path: refresh existing row with latest payload
        const updated = await prisma.notification.update({
          where: { id: existing.id },
          data: {
            title: params.title,
            body: params.body,
            ...(params.metadata ? { metadata: params.metadata } : {}),
            ...(params.userId ? { userId: params.userId } : {}),
          },
        })
        logger.info("Notification deduped (existing reused)", {
          workspaceId: params.workspaceId,
          notificationId: existing.id,
          type: params.type,
          channel: params.channel,
        })
        return updated
      }
    }
    throw error
  }
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
      // A personal feed includes the caller's notifications and workspace-wide
      // notices, but never another member's personal notifications.
      ...(params.userId ? { OR: [{ userId: params.userId }, { userId: null }] } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.type ? { type: params.type } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  })

  const hasMore = notifications.length > limit
  const items = hasMore ? notifications.slice(0, limit) : notifications
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

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

export async function markAllNotificationsRead(
  workspaceId: string,
  userId: string
): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { workspaceId, userId, status: { not: "read" }, deletedAt: null },
    data: { status: "read" },
  })
  return result.count
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
const DELIVERY_LEASE_MS = 5 * 60 * 1000

export async function createAndSendNotification(params: {
  workspaceId: string
  type: string
  title: string
  body: string
  workspaceName?: string
  channels?: readonly string[]
  dedupeKey?: string
  sendFn: (
    channel: string,
    payload: { type: string; title: string; body: string; workspaceName?: string }
  ) => Promise<boolean>
}): Promise<void> {
  const channels = params.channels ?? DEFAULT_CHANNELS

  for (const channel of channels) {
    const dedupeKey = computeNotificationDedupeKey({
      workspaceId: params.workspaceId,
      type: params.type,
      title: params.title,
      body: params.body,
      dedupeKey: params.dedupeKey,
    })

    let notification: Notification | null = null
    try {
      notification = await prisma.notification.create({
        data: {
          workspaceId: params.workspaceId,
          channel,
          type: params.type,
          title: params.title,
          body: params.body,
          status: "pending",
          dedupeKey,
        },
      })
      logger.info("Notification created", {
        workspaceId: params.workspaceId,
        notificationId: notification.id,
        type: params.type,
        channel,
      })
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await prisma.notification.findFirst({
          where: { channel, dedupeKey },
        })
        if (!existing) throw error
        notification = existing
        logger.info("Notification deduped (reusing delivery identity)", {
          workspaceId: params.workspaceId,
          notificationId: existing.id,
          type: params.type,
          channel,
        })
      } else {
        throw error
      }
    }

    if (!notification) continue

    const now = new Date()
    const claimed = await prisma.notification.updateMany({
      where: {
        id: notification.id,
        OR: [
          { status: { in: ["pending", "failed"] } },
          { status: "sending", deliveryLeaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        status: "sending",
        deliveryLeaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
        deliveryAttempts: { increment: 1 },
      },
    })
    if (claimed.count === 0) {
      logger.info("Notification delivery already claimed or sent", {
        workspaceId: params.workspaceId,
        notificationId: notification.id,
        type: params.type,
        channel,
      })
      continue
    }

    let sent = false
    try {
      sent = await params.sendFn(channel, {
        type: params.type,
        title: params.title,
        body: params.body,
        workspaceName: params.workspaceName,
      })
    } catch (error) {
      logger.error("Notification delivery threw", {
        workspaceId: params.workspaceId,
        notificationId: notification.id,
        channel,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (sent) {
      await prisma.notification.updateMany({
        where: { id: notification.id, status: "sending" },
        data: { status: "sent", sentAt: new Date(), deliveryLeaseExpiresAt: null },
      })
    } else {
      await prisma.notification.updateMany({
        where: { id: notification.id, status: "sending" },
        data: { status: "failed", deliveryLeaseExpiresAt: null },
      })
    }
  }
}
