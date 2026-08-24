import { getSystemPrisma } from "@lyrashield/db"
import type { PlatformAdminIdentity } from "@lyrashield/auth/server"

export const PLATFORM_ADMIN_PAGE_SIZE = 25

export function parseAdminCursor(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined
}

function page<T extends { id: string }>(rows: T[]) {
  const hasMore = rows.length > PLATFORM_ADMIN_PAGE_SIZE
  const items = hasMore ? rows.slice(0, PLATFORM_ADMIN_PAGE_SIZE) : rows
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null }
}

export async function getPlatformAdminUsers(_identity: PlatformAdminIdentity, cursor?: string) {
  const rows = await getSystemPrisma().user.findMany({
    orderBy: { id: "desc" },
    take: PLATFORM_ADMIN_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      email: true,
      emailVerified: true,
      platformRole: true,
      twoFactorEnabled: true,
      createdAt: true,
    },
  })
  return page(rows)
}

export async function getPlatformAdminWorkspaces(
  _identity: PlatformAdminIdentity,
  cursor?: string
) {
  const rows = await getSystemPrisma().workspace.findMany({
    where: { deletedAt: null },
    orderBy: { id: "desc" },
    take: PLATFORM_ADMIN_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      name: true,
      plan: true,
      createdAt: true,
      _count: { select: { members: true, targets: true } },
    },
  })
  return page(
    rows.map(({ _count, ...workspace }) => ({
      ...workspace,
      memberCount: _count.members,
      targetCount: _count.targets,
    }))
  )
}

export async function getPlatformAdminScans(_identity: PlatformAdminIdentity, cursor?: string) {
  const rows = await getSystemPrisma().scan.findMany({
    where: { deletedAt: null },
    orderBy: { id: "desc" },
    take: PLATFORM_ADMIN_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      status: true,
      mode: true,
      createdAt: true,
      startedAt: true,
      endedAt: true,
      workspace: { select: { id: true, name: true } },
      target: { select: { id: true, name: true } },
    },
  })
  return page(rows)
}

export async function getPlatformAdminAudit(_identity: PlatformAdminIdentity, cursor?: string) {
  const prisma = getSystemPrisma()
  const rows = await prisma.platformAdminAudit.findMany({
    orderBy: { id: "desc" },
    take: PLATFORM_ADMIN_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      actorUserId: true,
      action: true,
      resourceType: true,
      resourceId: true,
      createdAt: true,
    },
  })
  const actorUserIds = [...new Set(rows.map((row) => row.actorUserId))]
  const actors = actorUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorUserIds } },
        select: { id: true, email: true },
      })
    : []
  const actorEmails = new Map(actors.map((actor) => [actor.id, actor.email]))

  return page(
    rows.map(({ actorUserId, ...row }) => ({
      ...row,
      actorEmail: actorEmails.get(actorUserId) ?? "Deleted user",
    }))
  )
}
