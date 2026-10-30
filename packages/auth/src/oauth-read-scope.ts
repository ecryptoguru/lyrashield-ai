import type { AuthSession } from "./session"

export interface OAuthReadScope {
  targetId?: string
  /** Undefined means all workspace targets; an empty array means no targets. */
  targetIds?: string[]
}

/** Apply the live, authenticated connection grant before querying target-owned data. */
export function resolveOAuthReadScope(
  session: Pick<AuthSession, "oauth">,
  targetId?: string | null,
  requireTarget = false
): OAuthReadScope {
  const connection = session.oauth
  if (connection?.connectionId && !connection.allTargets) {
    if (targetId) {
      if (!connection.allowedTargetIds?.includes(targetId)) throw new Error("FORBIDDEN")
    } else {
      if (requireTarget) throw new Error("FORBIDDEN")
      return { targetIds: connection.allowedTargetIds ?? [] }
    }
  }
  return targetId ? { targetId } : {}
}
