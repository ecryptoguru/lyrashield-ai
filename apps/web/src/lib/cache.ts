import { cache } from "react"
import { cookies } from "next/headers"
import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"
import { selectActiveWorkspaceId } from "./workspace-selection"

export const getCachedSession = cache(async () => {
  return getSession()
})

export const getCachedWorkspaceId = cache(async (userId: string) => {
  const cookieStore = await cookies()
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, status: "active" },
    select: { workspaceId: true },
    orderBy: { createdAt: "asc" },
  })
  return selectActiveWorkspaceId(memberships, cookieStore.get("activeWorkspaceId")?.value)
})

export const getCachedProjects = cache(async (workspaceId: string) => {
  return prisma.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })
})

export const getCachedWorkspaces = cache(async (userId: string) => {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, status: "active" },
    include: { workspace: true },
  })
  return memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    mode: m.workspace.mode,
    plan: m.workspace.plan,
    role: m.role,
  }))
})

export const getCachedDashboardStats = cache(async (workspaceIdsKey: string) => {
  const workspaceIds = workspaceIdsKey.split(",").filter(Boolean)
  if (workspaceIds.length === 0) return { scanCount: 0, findingCount: 0, projectCount: 0 }
  const [scanCount, findingCount, projectCount] = await Promise.all([
    prisma.scan.count({ where: { workspaceId: { in: workspaceIds } } }),
    prisma.finding.count({ where: { workspaceId: { in: workspaceIds } } }),
    prisma.project.count({ where: { workspaceId: { in: workspaceIds } } }),
  ])
  return { scanCount, findingCount, projectCount }
})

export const getCachedOnboardingState = cache(async (userId: string) => {
  return prisma.onboardingState.findUnique({
    where: { userId },
  })
})

export const getCachedFindings = cache(async (workspaceId: string) => {
  return prisma.finding.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    take: 50,
    include: {
      target: { select: { id: true, name: true, type: true } },
      _count: {
        select: {
          evidence: { where: { redactionStatus: { not: "deleted" } } },
          fixProposals: { where: { deletedAt: null } },
        },
      },
    },
  })
})
