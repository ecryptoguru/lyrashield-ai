import { cache } from "react"
import { cookies } from "next/headers"
import { listFindings, prisma } from "@lyrashield/db"
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
    select: {
      role: true,
      workspace: {
        select: { id: true, name: true, slug: true, mode: true, plan: true },
      },
    },
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

export const getCachedOnboardingState = cache(async (userId: string) => {
  return prisma.onboardingState.findUnique({
    where: { userId },
  })
})

export const getCachedFindings = cache(async (workspaceId: string) => {
  return listFindings({ workspaceId })
})
