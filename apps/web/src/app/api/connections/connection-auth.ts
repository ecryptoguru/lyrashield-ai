import { hasPermission, PERMISSIONS } from "@lyrashield/auth"
import { requirePermission } from "@lyrashield/auth/server"
import { getAgentConnection } from "@lyrashield/db"

export async function requireBrowserConnectionManager(workspaceId: string, connectionId?: string) {
  const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.agent.act)
  if (session.apiKey || session.oauth) throw new Error("FORBIDDEN")

  if (connectionId) {
    const connection = await getAgentConnection(connectionId, workspaceId)
    if (!connection) return { session, workspace, connection: null }
    if (
      connection.userId !== session.userId &&
      !hasPermission(workspace.role, PERMISSIONS.agent.approve)
    ) {
      throw new Error("FORBIDDEN")
    }
    return { session, workspace, connection }
  }

  return { session, workspace, connection: null }
}
