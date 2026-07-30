import type { LyraShieldClient } from "../client"

export interface ListTargetsQuery {
  workspaceId?: string
  projectId?: string
  cursor?: string
  limit?: number
}

export function listTargets(client: LyraShieldClient, query: ListTargetsQuery = {}) {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.projectId) params.set("projectId", query.projectId)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit) params.set("limit", String(query.limit))
  const qs = params.toString()
  return client.request("GET", qs ? `/targets?${qs}` : "/targets")
}
