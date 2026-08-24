import { getSystemPrisma } from "@lyrashield/db"

export const PLATFORM_ADMIN_PAGE_SIZE = 25

export function parseAdminCursor(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined
}

function page<T extends { id: string }>(rows: T[]) {
  const hasMore = rows.length > PLATFORM_ADMIN_PAGE_SIZE
  const items = hasMore ? rows.slice(0, PLATFORM_ADMIN_PAGE_SIZE) : rows
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null }
}

export async function getPlatformAdminUsers(cursor?: string) {
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

export async function getPlatformAdminWorkspaces(cursor?: string) {
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

export async function getPlatformAdminScans(cursor?: string) {
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

export async function getPlatformAdminAudit(cursor?: string) {
  const rows = await getSystemPrisma().platformAdminAudit.findMany({
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
  return page(rows)
}
