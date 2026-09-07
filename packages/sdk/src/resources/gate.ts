import type { LyraShieldClient } from "../client"
import { GateVerdictQuerySchema, GateVerdictResponseSchema } from "../schemas"
import { z } from "zod"

export type GateVerdictQuery = z.input<typeof GateVerdictQuerySchema>

/** Read a versioned gate result. Without a release identity it is historical only and fails closed. */
export function getGateVerdict(
  client: LyraShieldClient,
  targetId: string,
  query: GateVerdictQuery
): Promise<z.infer<typeof GateVerdictResponseSchema>> {
  const parsed = GateVerdictQuerySchema.parse({
    ...query,
    workspaceId: query.workspaceId ?? client.workspaceId,
  })
  const params = new URLSearchParams({ workspaceId: parsed.workspaceId })
  if (parsed.commit) params.set("commit", parsed.commit)
  if (parsed.artifactDigest) params.set("artifactDigest", parsed.artifactDigest)
  return client.request("GET", `/gate/${encodeURIComponent(targetId)}?${params.toString()}`, {
    parse: (data) => GateVerdictResponseSchema.parse(data),
  })
}
