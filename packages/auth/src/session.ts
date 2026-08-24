import { headers } from "next/headers"
import { auth } from "./auth"
import { prisma, setWorkspaceContext, verifyApiKey } from "@lyrashield/db"
import type { MemberRole, WorkspaceMember } from "@lyrashield/db"
import { hasPermission, hasMinimumRole, type Permission } from "./permissions"
import { verifyOAuthBearer, type OAuthBearerContext } from "./oauth"
import { env } from "@lyrashield/config"

export interface ApiKeyAuthContext {
  keyId: string
  /** The single workspace this key may authorize. */
  workspaceId: string
  scopes: string[]
  prefix: string
}

export type OAuthAuthContext = OAuthBearerContext

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
  /** Present for a hosted MCP request authenticated with an OAuth bearer token. */
  oauth?: OAuthAuthContext
}

declare const platformAdminIdentityBrand: unique symbol

/** Browser identity that passed the platform-admin allowlist, role, and recent-TOTP gates. */
export type PlatformAdminIdentity = AuthSession & {
  readonly [platformAdminIdentityBrand]: true
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

const PLATFORM_ADMIN_EMAILS = new Set(env.PLATFORM_ADMIN_EMAILS.split(","))
export const MAX_PLATFORM_ADMIN_ELEVATION_AGE_MS = 30 * 60 * 1000
export const MAX_PLATFORM_ADMIN_READ_AGE_MS = 12 * 60 * 60 * 1000

async function getBearerSession(): Promise<AuthSession | null> {
  const headerList = await headers()
  const authorization = headerList.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return null

  const rawToken = authorization.slice("Bearer ".length).trim()
  if (!rawToken) return null

  const verified = rawToken.startsWith("lsk_") ? await verifyApiKey(rawToken) : null
  const oauth = verified ? null : await verifyOAuthBearer(rawToken)
  if (!verified && !oauth) return null

  const userId = verified?.createdById ?? oauth?.userId
  if (!userId) return null

  // The key acts on behalf of its creator. If the creator is gone (deleted
  // account), the key dies with them.
  const creator = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, image: true },
  })
  if (!creator) return null

  return {
    userId: creator.id,
    userEmail: creator.email,
    userName: creator.name,
    userImage: creator.image ?? null,
    sessionId: verified ? `apikey:${verified.keyId}` : (oauth?.sessionId ?? `oauth:${userId}`),
    ...(verified
      ? {
          apiKey: {
            keyId: verified.keyId,
            workspaceId: verified.workspaceId,
            scopes: verified.scopes,
            prefix: verified.prefix,
          },
        }
      : { oauth: oauth! }),
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
  return getBearerSession()
}

export async function requireAuth(): Promise<AuthSession> {
  const session = await getSession()
  if (!session) {
    throw new Error("UNAUTHORIZED")
  }
  return session
}

/**
 * Safe eligibility predicate for navigation and not-found routing. It applies
 * the complete browser identity guard; workspace roles never grant this access.
 */
export async function isPlatformOperator(userId: string): Promise<boolean> {
  try {
    return (await requirePlatformAdminIdentity()).userId === userId
  } catch {
    return false
  }
}

export async function requirePlatformOperator(): Promise<AuthSession> {
  return requirePlatformAdmin()
}

/**
 * Read-only platform administration accepts only a verified browser-cookie
 * session from an explicitly allowlisted, TOTP-enabled platform operator.
 * Bearer credentials remain tenant-scoped and can never cross this boundary.
 */
export async function requirePlatformAdminCandidateIdentity(): Promise<AuthSession> {
  const requestHeaders = await headers()
  if (requestHeaders.get("authorization") || !requestHeaders.get("cookie")) {
    throw new Error("UNAUTHORIZED")
  }

  const browserSession = await auth.api.getSession({ headers: requestHeaders })
  if (!browserSession) throw new Error("UNAUTHORIZED")

  const user = await prisma.user.findUnique({
    where: { id: browserSession.user.id },
    select: {
      email: true,
      emailVerified: true,
      platformRole: true,
      twoFactorEnabled: true,
    },
  })
  const normalizedEmail = user?.email.trim().toLowerCase()
  if (
    !user ||
    !normalizedEmail ||
    !PLATFORM_ADMIN_EMAILS.has(normalizedEmail) ||
    !user.emailVerified ||
    user.platformRole !== "PLATFORM_OPERATOR" ||
    user.twoFactorEnabled !== true
  ) {
    throw new Error("FORBIDDEN")
  }

  return {
    userId: browserSession.user.id,
    userEmail: browserSession.user.email,
    userName: browserSession.user.name,
    userImage: browserSession.user.image ?? null,
    sessionId: browserSession.session.id,
  }
}

/** Require a TOTP-stamped current browser session before any global read. */
export async function requirePlatformAdminIdentity(): Promise<PlatformAdminIdentity> {
  const identity = await requirePlatformAdminCandidateIdentity()
  await requireRecentPlatformAdminTotp(identity, MAX_PLATFORM_ADMIN_READ_AGE_MS)
  return identity as PlatformAdminIdentity
}

async function requireRecentPlatformAdminTotp(
  identity: AuthSession,
  maxAgeMs: number
): Promise<void> {
  const elevation = await prisma.session.findUnique({
    where: { id: identity.sessionId },
    select: { userId: true, twoFactorVerifiedAt: true },
  })
  if (!elevation || elevation.userId !== identity.userId || !elevation.twoFactorVerifiedAt) {
    throw new Error("ADMIN_REAUTH_REQUIRED")
  }
  const ageMs = Date.now() - elevation.twoFactorVerifiedAt.getTime()
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) {
    throw new Error("ADMIN_REAUTH_REQUIRED")
  }
}

/**
 * Write authorization adds a fresh server-stamped TOTP elevation to the exact
 * browser identity check. Critical mutations also require an action-specific,
 * one-time nonce at their database boundary.
 *
 * Successful Better Auth TOTP verification stamps the exact server-side
 * session. A caller may require a shorter elevation window, but never extend
 * the 30-minute ceiling.
 */
export async function requirePlatformAdmin(options?: {
  maxElevationAgeMs?: number
}): Promise<AuthSession> {
  const identity = await requirePlatformAdminIdentity()
  const maxElevationAgeMs = options?.maxElevationAgeMs ?? MAX_PLATFORM_ADMIN_ELEVATION_AGE_MS
  if (
    !Number.isFinite(maxElevationAgeMs) ||
    maxElevationAgeMs <= 0 ||
    maxElevationAgeMs > MAX_PLATFORM_ADMIN_ELEVATION_AGE_MS
  ) {
    throw new Error("INVALID_ADMIN_ELEVATION_WINDOW")
  }
  await requireRecentPlatformAdminTotp(identity, maxElevationAgeMs)

  return identity
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
  if (session.oauth && session.oauth.workspaceId !== workspaceId) {
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
  const hasWriteScope =
    session.apiKey?.scopes.includes("write") ?? session.oauth?.scopes.includes("lyrashield.write")
  if ((session.apiKey || session.oauth) && !hasWriteScope) {
    if (!READ_SCOPE_PERMISSIONS.has(permission)) {
      throw new Error("FORBIDDEN")
    }
  }

  return { session, workspace }
}
