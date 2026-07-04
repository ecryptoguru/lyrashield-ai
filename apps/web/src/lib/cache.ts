import { cache } from "react"
import { prisma } from "@lyrashield/db"
import { getSession } from "@lyrashield/auth/server"

export const getCachedSession = cache(async () => {
  return getSession()
})

export const getCachedWorkspaceId = cache(async (userId: string) => {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, status: "active" },
    select: { workspaceId: true },
  })
  return memberships[0]?.workspaceId ?? null
})

export const getCachedProjects = cache(async (workspaceId: string) => {
  return prisma.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })
})
