import type { Integration } from "./generated/prisma"
import { withWorkspaceRLS, type ScopedTransaction } from "./rls"

export type WorkspaceNotificationChannel = "slack" | "discord"

export interface NotificationIntegrationSummary {
  id: string
  channel: WorkspaceNotificationChannel
  name: string
  status: string
  updatedAt: Date
}

const TYPES = { slack: "SLACK", discord: "DISCORD" } as const

// Lock acquisition (30s) + credential read (15s) + provider POST (10s) fit this cap.
const LOCK_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 60_000 }

async function lockDestination(tx: ScopedTransaction, externalId: string) {
  await tx.$executeRaw`SET LOCAL lock_timeout = '30s'`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${externalId}, 0))`
}

function identity(workspaceId: string, channel: WorkspaceNotificationChannel) {
  return {
    workspaceId,
    type: TYPES[channel],
    externalId: `notifications:${workspaceId}:${channel}`,
  }
}

function notificationIdentities(workspaceId: string) {
  return [identity(workspaceId, "slack"), identity(workspaceId, "discord")].map(
    ({ type, externalId }) => ({ type, externalId })
  )
}

function summary(
  row: Pick<Integration, "id" | "type" | "name" | "status" | "updatedAt">
): NotificationIntegrationSummary {
  return {
    id: row.id,
    channel: row.type === "SLACK" ? "slack" : "discord",
    name: row.name,
    status: row.status,
    updatedAt: row.updatedAt,
  }
}

/** Public projection deliberately excludes sealed credential references. */
export async function listNotificationIntegrations(
  workspaceId: string
): Promise<NotificationIntegrationSummary[]> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const rows = await tx.integration.findMany({
      where: { workspaceId, deletedAt: null, OR: notificationIdentities(workspaceId) },
      select: { id: true, type: true, name: true, status: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
    })
    return rows.map(summary)
  })
}

/** Server-only credential resolution; purpose identity keeps OAuth rows separate. */
export async function getWorkspaceNotificationChannels(workspaceId: string): Promise<
  Array<{
    channel: WorkspaceNotificationChannel
    configRef: string
  }>
> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const rows = await tx.integration.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: "active",
        configRef: { not: null },
        OR: notificationIdentities(workspaceId),
      },
      select: { type: true, configRef: true },
    })
    return rows.flatMap((row) =>
      row.configRef
        ? [
            {
              channel: row.type === "SLACK" ? ("slack" as const) : ("discord" as const),
              configRef: row.configRef,
            },
          ]
        : []
    )
  })
}

export async function saveNotificationIntegration(params: {
  workspaceId: string
  channel: WorkspaceNotificationChannel
  configRef: string
  name?: string
}): Promise<{ integration: NotificationIntegrationSummary; previousConfigRef: string | null }> {
  const { workspaceId, channel, configRef } = params
  const key = identity(workspaceId, channel)
  return withWorkspaceRLS(
    workspaceId,
    async (tx) => {
      // Share the delivery lock so replaced credentials are no longer in use at commit.
      await lockDestination(tx, key.externalId)
      const existing = await tx.integration.findFirst({ where: key, select: { configRef: true } })
      const data = {
        name:
          params.name ?? (channel === "slack" ? "Slack notifications" : "Discord notifications"),
        configRef,
        status: "active",
        deletedAt: null,
        capabilities: { purpose: "notifications" },
        metadata: { purpose: "notifications" },
      }
      const row = await tx.integration.upsert({
        where: { workspaceId_type_externalId: key },
        create: { ...key, ...data },
        update: data,
      })
      return { integration: summary(row), previousConfigRef: existing?.configRef ?? null }
    },
    LOCK_TRANSACTION_OPTIONS
  )
}

export async function disableNotificationIntegration(
  workspaceId: string,
  channel: WorkspaceNotificationChannel
): Promise<NotificationIntegrationSummary | null> {
  const key = identity(workspaceId, channel)
  return withWorkspaceRLS(
    workspaceId,
    async (tx) => {
      await lockDestination(tx, key.externalId)
      const updated = await tx.integration.updateMany({
        where: { ...key, deletedAt: null },
        data: { status: "disabled" },
      })
      if (updated.count === 0) return null
      const row = await tx.integration.findFirst({ where: { ...key, deletedAt: null } })
      return row ? summary(row) : null
    },
    LOCK_TRANSACTION_OPTIONS
  )
}

/**
 * Serializes active destination resolution and bounded delivery against reconnect/disable.
 * The callback must finish within 25s (15s credential read + 10s provider POST) and must
 * not perform audit writes or open nested DB transactions. A missing active row skips send.
 */
export async function withActiveWorkspaceNotificationDestination<T>(
  workspaceId: string,
  channel: WorkspaceNotificationChannel,
  send: (configRef: string) => Promise<T>
): Promise<T | null> {
  const key = identity(workspaceId, channel)
  return withWorkspaceRLS(
    workspaceId,
    async (tx) => {
      await lockDestination(tx, key.externalId)
      const row = await tx.integration.findFirst({
        where: { ...key, deletedAt: null, status: "active", configRef: { not: null } },
        select: { configRef: true },
      })
      if (!row?.configRef) return null
      return send(row.configRef)
    },
    LOCK_TRANSACTION_OPTIONS
  )
}
