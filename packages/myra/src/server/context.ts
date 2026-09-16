/**
 * Request → principal resolution. The actor is resolved outside the model —
 * client-asserted account/workspace/role fields never establish authority.
 *
 * Order: browser-cookie Better Auth session → verified `x-myra-session`
 * public token → null. API keys and OAuth bearers are deliberately not
 * accepted: they are narrower delegated credentials, not chat identities.
 */
import { auth, getWorkspaceMembership } from "@lyrashield/auth/server"
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
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null)
  if (session?.user?.id && session.session?.id) {
    const workspace = await resolveActiveWorkspace(request, session.user.id)
    return {
      principal: {
        kind: "user",
        accountId: session.user.id,
        sessionId: session.session.id,
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
 * Resolve the caller's active workspace: the `activeWorkspaceId` cookie is a
 * hint only — it is accepted only when a current active membership exists.
 */
async function resolveActiveWorkspace(
  request: Request,
  userId: string
): Promise<{ workspaceId: string; role: string } | null> {
  const cookieHeader = request.headers.get("cookie") ?? ""
  const requested = /(?:^|;\s*)activeWorkspaceId=([^;]+)/.exec(cookieHeader)?.[1]
  if (!requested) return null
  const membership = await getWorkspaceMembership(requested, userId).catch(() => null)
  if (!membership) return null
  return { workspaceId: requested, role: membership.role }
}
