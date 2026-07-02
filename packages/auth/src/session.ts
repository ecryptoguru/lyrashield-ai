import { headers } from "next/headers"
import { auth } from "./auth"
import { prisma } from "@lyrashield/db"
import type { MemberRole, WorkspaceMember } from "@lyrashield/db"
import { hasPermission, hasMinimumRole } from "./permissions"

export interface AuthSession {
  userId: string
  userEmail: string
  userName: string
  userImage: string | null
  sessionId: string
}

export interface WorkspaceContext {
  member: WorkspaceMember
  role: MemberRole
}

export async function getSession(): Promise<AuthSession | null> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session) return null

  return {
    userId: session.user.id,
    userEmail: session.user.email,
    userName: session.user.name,
    userImage: session.user.image ?? null,
    sessionId: session.session.id,
  }
}

export async function requireAuth(): Promise<AuthSession> {
  const session = await getSession()
  if (!session) {
    throw new Error("UNAUTHORIZED")
  }
  return session
}

export async function getWorkspaceMembership(
  workspaceId: string,
  userId: string
): Promise<WorkspaceContext | null> {
  const member = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId, userId },
    },
  })

  if (!member || member.status !== "active") return null

  return {
    member,
    role: member.role,
  }
}

export async function requireWorkspaceAccess(
  workspaceId: string,
  minimumRole?: MemberRole
): Promise<{ session: AuthSession; workspace: WorkspaceContext }> {
  const session = await requireAuth()
  const ctx = await getWorkspaceMembership(workspaceId, session.userId)

  if (!ctx) {
    throw new Error("FORBIDDEN")
  }

  if (minimumRole && !hasMinimumRole(ctx.role, minimumRole)) {
    throw new Error("FORBIDDEN")
  }

  return { session, workspace: ctx }
}

export async function requirePermission(
  workspaceId: string,
  permission: string
): Promise<{ session: AuthSession; workspace: WorkspaceContext }> {
  const { session, workspace } = await requireWorkspaceAccess(workspaceId)

  if (!hasPermission(workspace.role, permission)) {
    throw new Error("FORBIDDEN")
  }

  return { session, workspace }
}
