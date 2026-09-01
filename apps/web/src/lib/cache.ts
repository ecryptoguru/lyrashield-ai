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
  const cookieStore = await cookies()
  const memberships = await prisma.workspaceMember.findMany({
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

export const DASHBOARD_CACHE_TAG = "dashboard-aggregates"

export function revalidateDashboardAggregates() {
  // Mutations need the next dashboard request to see the new state. The
  // default profile serves stale data while revalidating in the background.
  revalidateTag(DASHBOARD_CACHE_TAG, { expire: 0 })
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

export const getCachedDashboardOverview = unstable_cache(
  async (workspaceId: string) => getDashboardOverview(workspaceId),
  ["dashboard-overview"],
  { revalidate: 30, tags: [DASHBOARD_CACHE_TAG] }
)
