import type { LyraShieldClient } from "../client"
import { z } from "zod"
import { LaunchReadinessSchema } from "../schemas"

export interface LaunchReadinessQuery {
  workspaceId?: string
  targetId?: string
  commit?: string
  artifactDigest?: string
}

export function getLaunchReadiness(
  client: LyraShieldClient,
  query: LaunchReadinessQuery = {}
): Promise<z.infer<typeof LaunchReadinessSchema>> {
  const params = new URLSearchParams()
  const workspaceId = query.workspaceId ?? client.workspaceId
  if (workspaceId) params.set("workspaceId", workspaceId)
  if (query.targetId) params.set("targetId", query.targetId)
  if (query.commit) params.set("commit", query.commit)
  if (query.artifactDigest) params.set("artifactDigest", query.artifactDigest)
  const qs = params.toString()
  return client.request("GET", qs ? `/launch-readiness?${qs}` : "/launch-readiness", {
    parse: (data) => LaunchReadinessSchema.parse(data),
  })
}
