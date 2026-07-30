import type { LyraShieldClient } from "../client"

export interface LaunchReadinessQuery {
  workspaceId?: string
  targetId?: string
}

export function getLaunchReadiness(client: LyraShieldClient, query: LaunchReadinessQuery = {}) {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.targetId) params.set("targetId", query.targetId)
  const qs = params.toString()
  return client.request("GET", qs ? `/launch-readiness?${qs}` : "/launch-readiness")
}
