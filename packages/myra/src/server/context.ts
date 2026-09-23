/**
 * Request → principal resolution. The actor is resolved outside the model —
 * client-asserted account/workspace/role fields never establish authority.
 *
 * Order: browser-cookie Better Auth session → verified `x-myra-session`
 * public token → null. API keys and OAuth bearers are deliberately not
 * accepted: they are narrower delegated credentials, not chat identities.
 */
import type { MyraPrincipal } from "../contracts"
import { readPublicToken, verifyPublicToken } from "./session"
import type { MyraDb } from "./db"

export interface ResolvedMyraRequest {
  principal: MyraPrincipal
  /** Verified active workspace for authenticated users; null otherwise. */
  workspaceId: string | null
  role: string | null
}

export async function resolveMyraRequest(
  request: Request,
  db?: MyraDb
): Promise<ResolvedMyraRequest | null> {
  // The worker imports the Myra server barrel for maintenance. Keep the
  // Next-only auth session module behind this request-only boundary.
  const { auth } = await import("@lyrashield/auth/server")
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null)
  if (session?.user?.id && session.session?.id) {
    const workspace = await resolveActiveWorkspace(request, session.user.id)
    return {
      principal: {
        kind: "user",
        accountId: session.user.id,
        sessionId: session.session.id,
        email: session.user.email,
        emailVerified: session.user.emailVerified,
        // Per contract: resolved lazily by tools that need them.
        workspaceId: null,
        role: null,
      },
      workspaceId: workspace?.workspaceId ?? null,
      role: workspace?.role ?? null,
    }
  }

  const token = readPublicToken(request)
  if (token) {
    const publicSessionId = await verifyPublicToken(token, db)
    if (publicSessionId) {
      return {
        principal: { kind: "anonymous", publicSessionId },
        workspaceId: null,
        role: null,
      }
    }
  }
  return null
}

/**
 * Resolve the caller's active workspace. The cookie is a hint only; when it
 * is absent or stale, use the same oldest active membership as the dashboard.
 */
async function resolveActiveWorkspace(
  request: Request,
  userId: string
): Promise<{ workspaceId: string; role: string } | null> {
  const { getWorkspaceMembership } = await import("@lyrashield/auth/server")
  const cookieHeader = request.headers.get("cookie") ?? ""
  const requested = /(?:^|;\s*)activeWorkspaceId=([^;]+)/.exec(cookieHeader)?.[1]
  if (requested) {
    const membership = await getWorkspaceMembership(requested, userId).catch(() => null)
    if (membership) return { workspaceId: requested, role: membership.role }
  }
  const { prisma } = await import("@lyrashield/db")
  return prisma.workspaceMember
    .findFirst({
      where: { userId, status: "active" },
      orderBy: { createdAt: "asc" },
      select: { workspaceId: true, role: true },
    })
    .catch(() => null)
}
