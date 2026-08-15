import minimist from "minimist"
import { createClient } from "../client.js"
import { getEffectiveCredentials, requireWorkspace } from "../credentials.js"
import type { Output } from "../output.js"
import { listFindings } from "@lyrashield/sdk"

export async function handleFindings(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    string: ["severity", "status", "target", "scan", "verified"],
    boolean: ["stats"],
  })

  const workspaceId = requireWorkspace(await getEffectiveCredentials())
  const client = await createClient()
  const res = await listFindings(client, {
    workspaceId,
    severity: parsed.severity as string | undefined,
    status: parsed.status as string | undefined,
    targetId: parsed.target as string | undefined,
  })

  if (parsed.stats) {
    const bySeverity = new Map<string, number>()
    for (const f of res.items) {
      bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1)
    }
    output.result({ findings: res.items, stats: Object.fromEntries(bySeverity) })
  } else {
    output.result(res)
  }

  return 0
}
