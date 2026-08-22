import type { AuthSession } from "@lyrashield/auth/server"

/** Cloud Sync mutates workspace evidence; bearer credentials need exact workspace + write scope. */
export function hasSyncWriteAccess(session: AuthSession, workspaceId: string): boolean {
  if (session.apiKey) {
    return session.apiKey.workspaceId === workspaceId && session.apiKey.scopes.includes("write")
  }
  if (session.oauth) {
    return (
      session.oauth.workspaceId === workspaceId && session.oauth.scopes.includes("lyrashield.write")
    )
  }
  return true
}
