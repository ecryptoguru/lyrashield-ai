import { getDelegatedActiveTargetIds, getDelegatedScanAccess } from "@lyrashield/db"
import { resolveOAuthReadScope } from "@lyrashield/auth/server"
import type { AuthSession, WorkspaceContext } from "@lyrashield/auth/server"

export interface DelegatedTargetReadScope {
  targetId?: string
  targetIds?: string[]
  allowedProfiles?: string[]
  requireActiveTarget?: boolean
}

export function delegatedReadPrincipal(session: AuthSession, workspace: WorkspaceContext) {
  if (!session.oauth?.connectionId || !session.oauth.authorizationVersion) return null
  return {
    workspaceId: session.oauth.workspaceId,
    userId: session.userId,
    memberId: workspace.member.id,
    memberRole: workspace.member.role,
    memberUpdatedAt: workspace.member.updatedAt,
    connectionId: session.oauth.connectionId,
    authorizationVersion: session.oauth.authorizationVersion,
    allTargets: session.oauth.allTargets === true,
    allowedTargetIds: session.oauth.allowedTargetIds ?? [],
  }
}

export async function delegatedScanAccess(
  session: AuthSession,
  workspace: WorkspaceContext,
  scanId: string,
  client?: Parameters<typeof getDelegatedScanAccess>[1]
) {
  const principal = delegatedReadPrincipal(session, workspace)
  return principal ? getDelegatedScanAccess({ ...principal, scanId }, client) : null
}

export async function resolveDelegatedTargetReadScope(
  session: AuthSession,
  workspace: WorkspaceContext,
  targetId?: string | null
): Promise<DelegatedTargetReadScope> {
  const scope = resolveOAuthReadScope(session, targetId)
  const principal = delegatedReadPrincipal(session, workspace)
  if (!principal) return scope

  const activeIds = await getDelegatedActiveTargetIds({
    ...principal,
    ...(targetId ? { targetId } : {}),
  })
  if (targetId) {
    if (!activeIds) throw new Error("FORBIDDEN")
    return { targetId, requireActiveTarget: true }
  }
  return {
    targetIds:
      scope.targetIds === undefined
        ? (activeIds ?? [])
        : scope.targetIds.filter((id) => activeIds?.includes(id)),
    requireActiveTarget: true,
  }
}
