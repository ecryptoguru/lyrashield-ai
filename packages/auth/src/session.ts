import { headers } from "next/headers"
import { auth } from "./auth"
import { prisma, setWorkspaceContext, verifyApiKey } from "@lyrashield/db"
import type { MemberRole, WorkspaceMember } from "@lyrashield/db"
import { hasPermission, hasMinimumRole, type Permission } from "./permissions"

export interface ApiKeyAuthContext {
  keyId: string
  /** The single workspace this key may authorize. */
  workspaceId: string
  scopes: string[]
  prefix: string
}

export interface AuthSession {
  userId: string
  userEmail: string
  userName: string
  userImage: string | null
  sessionId: string
  /**
   * Present when the request authenticated with a workspace API key
   * (`Authorization: Bearer lsk_...`) instead of a browser session. Key-based
   * auth is strictly narrower than a session: it only authorizes its own
   * workspace, and read-only keys are rejected for mutating permissions.
   */
  apiKey?: ApiKeyAuthContext
}

/**
 * Permissions a read-only ("read" scope) API key may exercise. Everything not
 * listed requires the "write" scope — fail-closed for any newly added
 * permission.
 */
const READ_SCOPE_PERMISSIONS: ReadonlySet<string> = new Set([
  "scan:view",
  "finding:view",
  "retest:view",
  "notification:view",
  "schedule:view",
  "audit:view",
  "agent:view",
  "report:download",
])

async function getApiKeySession(): Promise<AuthSession | null> {
  const headerList = await headers()
  const authorization = headerList.get("authorization")
  if (!authorization?.startsWith("Bearer lsk_")) return null

  const verified = await verifyApiKey(authorization.slice("Bearer ".length).trim())
  if (!verified) return null

  // The key acts on behalf of its creator. If the creator is gone (deleted
  // account), the key dies with them.
  const creator = await prisma.user.findUnique({
    where: { id: verified.createdById },
    select: { id: true, email: true, name: true, image: true },
  })
  if (!creator) return null

  return {
    userId: creator.id,
    userEmail: creator.email,
    userName: creator.name,
    userImage: creator.image ?? null,
    sessionId: `apikey:${verified.keyId}`,
    apiKey: {
      keyId: verified.keyId,
      workspaceId: verified.workspaceId,
      scopes: verified.scopes,
      prefix: verified.prefix,
    },
  }
}

export interface WorkspaceContext {
  member: WorkspaceMember
  role: MemberRole
}

export async function getSession(): Promise<AuthSession | null> {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (session) {
    return {
      userId: session.user.id,
      userEmail: session.user.email,
      userName: session.user.name,
      userImage: session.user.image ?? null,
      sessionId: session.session.id,
    }
  }

  // No browser session — fall back to workspace API key bearer auth
  // (MCP server, CLI, CI). Cookie sessions always win when both are present.
  return getApiKeySession()
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

  // Workspace API keys are single-workspace credentials: a key minted for
  // workspace A must never authorize workspace B, even when the key's creator
  // is a member of both.
  if (session.apiKey && session.apiKey.workspaceId !== workspaceId) {
    throw new Error("FORBIDDEN")
  }

  const ctx = await getWorkspaceMembership(workspaceId, session.userId)

  if (!ctx) {
    throw new Error("FORBIDDEN")
  }

  if (minimumRole && !hasMinimumRole(ctx.role, minimumRole)) {
    throw new Error("FORBIDDEN")
  }

  // Activate request-scoped workspace context (AsyncLocalStorage) once access
  // is confirmed. From here on, workspace-scoped Prisma reads that don't already
  // carry an explicit `workspaceId` are auto-scoped to this workspace as a
  // defense-in-depth backstop against a forgotten `where: { workspaceId }`.
  // Safe for existing routes: they pass workspaceId explicitly, so injection is
  // a no-op; cross-workspace models (WorkspaceMember, OnboardingState) are
  // intentionally excluded from the scoped set.
  setWorkspaceContext(workspaceId)

  return { session, workspace: ctx }
}

export async function requirePermission(
  workspaceId: string,
  permission: Permission
): Promise<{ session: AuthSession; workspace: WorkspaceContext }> {
  const { session, workspace } = await requireWorkspaceAccess(workspaceId)

  if (!hasPermission(workspace.role, permission)) {
    throw new Error("FORBIDDEN")
  }

  // Scope enforcement for API-key auth: read-only keys may exercise only the
  // explicit read allowlist; everything else requires the "write" scope.
  if (session.apiKey && !session.apiKey.scopes.includes("write")) {
    if (!READ_SCOPE_PERMISSIONS.has(permission)) {
      throw new Error("FORBIDDEN")
    }
  }

  return { session, workspace }
}
