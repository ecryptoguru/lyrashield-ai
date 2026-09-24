import { createHash } from "node:crypto"
import { prisma } from "./client"
import type { Notification } from "./generated/prisma"
import { logger } from "@lyrashield/logger"
import {
  appendDigestLine,
  buildRoutineDigest,
  classifyNotificationPriority,
  routineGroupDedupeKey,
} from "./notification-grouping"

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
  const data = {
    workspaceId: params.workspaceId,
    ...(params.userId ? { userId: params.userId } : {}),
    channel: params.channel,
    type: params.type,
    title: params.title,
    body: params.body,
    status: "pending",
    dedupeKey,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  }
  const created = await prisma.notification.createMany({ data, skipDuplicates: true })
  const notification = await prisma.notification.findUnique({
    where: { channel_dedupeKey: { channel: params.channel, dedupeKey } },
  })
  if (!notification) throw new Error("Notification insert did not produce a durable row")

  if (created.count === 1) {
    logger.info("Notification created", {
      workspaceId: params.workspaceId,
      notificationId: notification.id,
      type: params.type,
      channel: params.channel,
    })

    return notification
  }

  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: {
      title: params.title,
      body: params.body,
      ...(params.metadata ? { metadata: params.metadata } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
    },
  })
  logger.info("Notification deduped (existing reused)", {
    workspaceId: params.workspaceId,
    notificationId: notification.id,
    type: params.type,
    channel: params.channel,
  })
  return updated
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
  /**
   * W3-06: when provided, a ROUTINE notification coalesces into one digest per
   * group window instead of delivering per event. Critical notification types
   * ignore grouping entirely and always deliver individually.
   */
  routineGroup?: { groupType: string; windowKey: string; windowLabel: string; detail: string }
  sendFn: (
    channel: string,
    payload: { type: string; title: string; body: string; workspaceName?: string }
  ) => Promise<boolean>
}): Promise<void> {
  const channels = params.channels ?? DEFAULT_CHANNELS

  // W3-06: routine events in the same group window share one dedupe key, so
  // concurrent/retried completions reuse one row (the unique-constraint path
  // below refreshes its payload) instead of fanning out per event. Critical
  // types ignore grouping and keep their exact-event dedupe key.
  const priority = classifyNotificationPriority(params.type)
  const grouped = params.routineGroup && priority === "routine"
  const digest = grouped
    ? buildRoutineDigest({
        groupType: params.routineGroup!.groupType,
        windowLabel: params.routineGroup!.windowLabel,
        items: [{ title: params.title, detail: params.routineGroup!.detail }],
      })
    : null
  const effectiveType = grouped ? digest!.type : params.type
  const effectiveTitle = grouped ? digest!.title : params.title
  const effectiveBody = grouped ? digest!.body : params.body
  const dedupeKey = grouped
    ? routineGroupDedupeKey({
        workspaceId: params.workspaceId,
        groupType: params.routineGroup!.groupType,
        windowKey: params.routineGroup!.windowKey,
      })
    : computeNotificationDedupeKey({
        workspaceId: params.workspaceId,
        type: params.type,
        title: params.title,
        body: params.body,
        dedupeKey: params.dedupeKey,
      })

  for (const channel of channels) {
    const data = {
      workspaceId: params.workspaceId,
      channel,
      type: effectiveType,
      title: effectiveTitle,
      body: effectiveBody,
      status: "pending",
      dedupeKey,
    }
    const created = await prisma.notification.createMany({ data, skipDuplicates: true })
    let notification = await prisma.notification.findUnique({
      where: { channel_dedupeKey: { channel, dedupeKey } },
    })
    if (!notification) throw new Error("Notification insert did not produce a durable row")

    if (created.count === 1) {
      logger.info("Notification created", {
        workspaceId: params.workspaceId,
        notificationId: notification.id,
        type: params.type,
        channel,
      })
    } else {
      // Grouped digests accumulate their event receipts instead of
      // overwriting, so earlier events in the window are not erased. The
      // list stays bounded with an explicit overflow note.
      if (grouped) {
        notification = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notification:${channel}:${dedupeKey}`}, 0))`
          const current = await tx.notification.findUnique({
            where: { channel_dedupeKey: { channel, dedupeKey } },
          })
          if (!current) throw new Error("Notification disappeared during digest update")
          return tx.notification.update({
            where: { id: current.id },
            data: {
              body: appendDigestLine(
                current.body,
                `• ${params.title} — ${params.routineGroup!.detail}`
              ),
            },
          })
        })
      }
      logger.info("Notification deduped (reusing delivery identity)", {
        workspaceId: params.workspaceId,
        notificationId: notification.id,
        type: params.type,
        channel,
      })
    }

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
        type: effectiveType,
        title: effectiveTitle,
        body: grouped ? notification.body : effectiveBody,
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
