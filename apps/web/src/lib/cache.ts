import { cache } from "react"
import { revalidateTag, unstable_cache } from "next/cache"
import { cookies } from "next/headers"
import { listFindings, prisma } from "@lyrashield/db"
import type { MemberRole } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { hasPermission, PERMISSIONS } from "@lyrashield/auth"
import { selectActiveWorkspaceId } from "./workspace-selection"
import { getDashboardOverview } from "./dashboard-overview"

export const getCachedSession = cache(async () => {
  return getSession()
})

export const getCachedWorkspaceContext = cache(async (userId: string) => {
  const [session, cookieStore] = await Promise.all([getCachedSession(), cookies()])
  // Fail closed for non-browser resolution: the dashboard only exists behind
  // an authenticated session, so a missing/mismatched session yields no
  // workspace rather than a trust decision on stale data.
  if (!session || session.userId !== userId) {
    return { workspaceId: null, workspaces: [] }
  }
  // A workspace-bound credential (API key or OAuth grant) sees exactly one
  // workspace — never the client-settable activeWorkspaceId cookie nor the
  // creator's other memberships. Browser sessions keep full selection.
  const boundWorkspaceId = session.apiKey?.workspaceId ?? session.oauth?.workspaceId ?? null
  const memberships = (
    await prisma.workspaceMember.findMany({
      where: { userId, status: "active" },
      select: {
        role: true,
        workspaceId: true,
        workspace: {
          select: { id: true, name: true, slug: true, mode: true, plan: true },
        },
      },
      orderBy: { createdAt: "asc" },
    })
  ).filter(
    (membership) => boundWorkspaceId === null || membership.workspaceId === boundWorkspaceId
  )
  const workspaceId = selectActiveWorkspaceId(
    memberships,
    cookieStore.get("activeWorkspaceId")?.value
  )
  const workspaces = memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    mode: m.workspace.mode,
    plan: m.workspace.plan,
    role: m.role,
  }))
  return { workspaceId, workspaces }
})

export const getCachedWorkspaceId = cache(async (userId: string) => {
  const { workspaceId } = await getCachedWorkspaceContext(userId)
  return workspaceId
})

export const getCachedWorkspaces = cache(async (userId: string) => {
  const { workspaces } = await getCachedWorkspaceContext(userId)
  return workspaces
})

export const getCachedProjects = cache(async (workspaceId: string) => {
  return prisma.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })
})

export const getCachedOnboardingState = cache(async (userId: string) => {
  return prisma.onboardingState.findUnique({
    where: { userId },
  })
})

export const getCachedFindings = cache(async (workspaceId: string) => {
  return listFindings({ workspaceId })
})

export const getCachedPendingApprovals = cache(
  async (workspaceId: string, role: MemberRole): Promise<number> => {
    if (!hasPermission(role, PERMISSIONS.agent.view)) return 0
    return prisma.agentApproval.count({
      where: { workspaceId, status: "PENDING" },
    })
  }
)

export function dashboardCacheTag(workspaceId: string) {
  return `dashboard-aggregates:${workspaceId}`
}

export function revalidateDashboardAggregates(workspaceId: string) {
  // Mutations need the next dashboard request to see the new state. The
  // default profile serves stale data while revalidating in the background.
  revalidateTag(dashboardCacheTag(workspaceId), { expire: 0 })
}

export const getCachedUnreadNotifications = cache(
  async (userId: string, workspaceId: string | null): Promise<number> => {
    if (!workspaceId) return 0
    return prisma.notification.count({
      where: {
        workspaceId,
        status: { not: "read" },
        deletedAt: null,
        OR: [{ userId }, { userId: null }],
      },
    })
  }
)

export function getCachedDashboardOverview(workspaceId: string) {
  return unstable_cache(
    async () => getDashboardOverview(workspaceId),
    ["dashboard-overview", workspaceId],
    { revalidate: 30, tags: [dashboardCacheTag(workspaceId)] }
  )()
}
