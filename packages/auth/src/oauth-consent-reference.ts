/**
 * Reference id bound into OAuth consent rows and authorization codes for
 * workspace-scoped grants (`{workspaceId}:{agentConnectionId}`).
 *
 * The provider invokes this on EVERY authorize run — including the
 * select-workspace `continue`, which runs before the consent form creates
 * the AgentConnection that stamps `session.pendingAgentConnectionId`. When
 * no pending connection exists yet we return a synthetic reference that can
 * never match a stored consent row (`{workspaceId}:__pending__`), so the
 * flow redirects to the consent page instead of failing the workspace
 * selection. A code issued under the sentinel fails closed at token claims:
 * the AgentConnection lookup rejects it.
 */

import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { activeWorkspaceIdFromCookie } from "./oauth-workspace"
import { OAUTH_SCOPE_READ, OAUTH_SCOPE_WRITE } from "./oauth-scopes"

/**
 * Resolve the workspace the signed-in user selected for this OAuth grant.
 * The selection is stamped by `/api/workspaces/active` — both the
 * `activeWorkspaceId` cookie and the session's `activeWorkspaceId` field.
 * A candidate counts only when the user still holds an ACTIVE membership.
 */
export async function selectedOAuthWorkspaceId({
  userId,
  session,
  requestHeaders,
}: {
  userId: string
  session: Record<string, unknown>
  requestHeaders: Headers
}): Promise<string | undefined> {
  const candidates = [
    activeWorkspaceIdFromCookie(requestHeaders.get("cookie")),
    typeof session.activeWorkspaceId === "string" ? session.activeWorkspaceId : undefined,
  ].filter((workspaceId): workspaceId is string => Boolean(workspaceId))

  for (const workspaceId of new Set(candidates)) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { status: true },
    })
    if (member?.status === "active") return workspaceId
  }

  return undefined
}

/** Sentinel connection id for the pre-consent phase; never a real cuid. */
export const OAUTH_PENDING_CONNECTION_REFERENCE = "__pending__"

export async function oauthConsentReferenceId(context: {
  user: { id: string }
  session: Record<string, unknown> | null
  scopes: string[]
}): Promise<string | undefined> {
  const { user, session, scopes } = context
  const needsWorkspace = scopes.includes(OAUTH_SCOPE_READ) || scopes.includes(OAUTH_SCOPE_WRITE)
  if (!needsWorkspace || !session) return undefined
  const workspaceId = await selectedOAuthWorkspaceId({
    userId: user.id,
    session,
    requestHeaders: new Headers(),
  })
  if (!workspaceId) throw new Error("OAUTH_WORKSPACE_REQUIRED")

  const connectionId =
    typeof session.pendingAgentConnectionId === "string"
      ? session.pendingAgentConnectionId
      : undefined
  if (!connectionId) return `${workspaceId}:${OAUTH_PENDING_CONNECTION_REFERENCE}`

  const conn = await withWorkspaceRLS(workspaceId, (tx) =>
    tx.agentConnection.findFirst({
      where: { id: connectionId, userId: user.id, workspaceId, status: "ACTIVE" },
    })
  )
  if (!conn) throw new Error("OAUTH_CONNECTION_REQUIRED")
  return `${workspaceId}:${conn.id}`
}
