import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"

export async function handleFindings(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: ["severity", "status", "target", "scan", "verified"],
    boolean: ["stats"],
  })

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const params = new URLSearchParams({ workspaceId })
  if (parsed.severity) params.set("severity", parsed.severity as string)
  if (parsed.status) params.set("status", parsed.status as string)
  if (parsed.target) params.set("targetId", parsed.target as string)
  if (parsed.scan) params.set("scanId", parsed.scan as string)
  if (parsed.verified) params.set("verified", parsed.verified as string)

  const client = await createClient()
  const res = await client.request("GET", `/api/v1/findings?${params.toString()}`)

  if (parsed.stats && Array.isArray(res)) {
    const bySeverity = new Map<string, number>()
    for (const f of res as { severity: string }[]) {
      bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1)
    }
    output.result({ findings: res, stats: Object.fromEntries(bySeverity) })
  } else {
    output.result(res)
  }

  return 0
}
