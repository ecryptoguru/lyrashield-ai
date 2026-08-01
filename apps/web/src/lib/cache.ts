import { cache } from "react"
import { revalidateTag, unstable_cache } from "next/cache"
import { cookies } from "next/headers"
import { listFindings, prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { selectActiveWorkspaceId } from "./workspace-selection"

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

export const DASHBOARD_CACHE_TAG = "dashboard-aggregates"

export function revalidateDashboardAggregates() {
  revalidateTag(DASHBOARD_CACHE_TAG, "default")
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

export const getCachedDashboardAggregates = unstable_cache(
  async (workspaceId: string) => {
    const [
      targetCount,
      openFindingCount,
      reportCount,
      findingGroups,
      completedScanCount,
      scoreSnapshots,
      recentScans,
      project,
    ] = await Promise.all([
      prisma.target.count({ where: { workspaceId, deletedAt: null } }),
      prisma.finding.count({
        where: {
          workspaceId,
          deletedAt: null,
          status: { notIn: ["FIXED", "FALSE_POSITIVE", "DUPLICATE"] },
        },
      }),
      prisma.report.count({ where: { workspaceId, deletedAt: null } }),
      prisma.finding.groupBy({
        by: ["severity", "status", "verified"],
        where: { workspaceId, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.scan.count({
        where: { workspaceId, deletedAt: null, status: "COMPLETED" },
      }),
      prisma.scoreSnapshot.findMany({
        where: { workspaceId },
        orderBy: { computedAt: "desc" },
        take: 10,
        select: { score: true, grade: true, computedAt: true },
      }),
      prisma.scan.findMany({
        where: { workspaceId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          createdAt: true,
          status: true,
          mode: true,
          target: { select: { name: true, type: true } },
          _count: { select: { findings: { where: { deletedAt: null } } } },
        },
      }),
      prisma.project.findFirst({
        where: { workspaceId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: { name: true, riskScore: true, trustPlan: true },
      }),
    ])

    return {
      targetCount,
      openFindingCount,
      reportCount,
      findingGroups,
      completedScanCount,
      scoreSnapshots,
      recentScans,
      project,
    }
  },
  ["dashboard-aggregates"],
  { revalidate: 30, tags: [DASHBOARD_CACHE_TAG] }
)
