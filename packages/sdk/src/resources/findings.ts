import type { LyraShieldClient } from "../client"

export interface FindingQuery {
  workspaceId?: string
  targetId?: string
  severity?: string
  status?: string
  cursor?: string
  limit?: number
}

export interface GetFindingQuery {
  workspaceId?: string
}

function buildFindingParams(query: FindingQuery, client: LyraShieldClient): URLSearchParams {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.targetId) params.set("targetId", query.targetId)
  if (query.severity) params.set("severity", query.severity)
  if (query.status) params.set("status", query.status)
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.limit) params.set("limit", String(query.limit))
  return params
}

export function listFindings(client: LyraShieldClient, query: FindingQuery = {}) {
  const params = buildFindingParams(query, client)
  const qs = params.toString()
  return client.request("GET", qs ? `/findings?${qs}` : "/findings")
}

export function getFinding(client: LyraShieldClient, id: string, query: GetFindingQuery = {}) {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  const qs = params.toString()
  const path = qs
    ? `/findings/${encodeURIComponent(id)}?${qs}`
    : `/findings/${encodeURIComponent(id)}`
  return client.request("GET", path)
}
