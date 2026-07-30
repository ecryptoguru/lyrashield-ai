import minimist from "minimist"
import type { AgentEntry, Transport } from "@lyrashield/agent-registry"
import { getEffectiveCredentials } from "../credentials.js"
import { installAgent } from "../installers/install.js"
import type { InstallAgentResult } from "../installers/install.js"
import type { Output } from "../output.js"

export async function handleInit(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    boolean: ["dry-run", "all", "global", "project", "inline-secret", "yes"],
    string: ["agent", "transport"],
    default: { transport: "stdio" },
  })

  const transport = parsed.transport as Transport
  if (!["stdio", "remote-http"].includes(transport)) {
    output.error("--transport must be stdio or remote-http")
    return 2
  }

  const creds = await getEffectiveCredentials()
  if (!creds.apiKey) {
    output.error("No API key. Run: lyrashield login")
    return 3
  }

  const scope = parsed.global ? "global" : parsed.project ? "project" : undefined
  const selectedAgents: string[] = Array.isArray(parsed.agent)
    ? parsed.agent
    : parsed.agent
      ? [parsed.agent]
      : []

  const registry = await import("@lyrashield/agent-registry").catch(
    () => ({}) as Record<string, unknown>
  )
  const list = (registry as Record<string, unknown>).listAgents as (() => AgentEntry[]) | undefined
  const arr = (registry as Record<string, unknown>).AGENTS as AgentEntry[] | undefined
  const allAgents = list?.() ?? arr ?? []

  if (!allAgents.length) {
    output.error("Agent registry is not available.")
    return 1
  }

  let agents = allAgents
  if (selectedAgents.length) {
    agents = allAgents.filter((a) => selectedAgents.includes(a.id))
    const missing = selectedAgents.filter((id) => !allAgents.some((a) => a.id === id))
    if (missing.length) {
      output.warn(`Unknown agent(s): ${missing.join(", ")}`)
    }
  }

  const results: InstallAgentResult[] = []
  for (const agent of agents) {
    const result = await installAgent({
      agent,
      transport,
      apiUrl: creds.apiUrl,
      apiKey: creds.apiKey,
      scope,
      all: parsed.all,
      dryRun: parsed["dry-run"],
      inlineSecret: parsed["inline-secret"],
      yes: parsed.yes,
    })
    results.push(result)
    if (!output.json) {
      const status = result.outcome.padEnd(18)
      output.log(`${status} ${agent.displayName}` + (result.path ? `  (${result.path})` : ""))
      if (result.message && (result.outcome === "MANUAL_REQUIRED" || result.outcome === "FAILED")) {
        output.notice(result.message)
      }
    }
  }

  if (output.json) {
    output.result(results)
  } else {
    const byOutcome = new Map<string, number>()
    for (const r of results) byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1)
    output.log("\nSummary:")
    for (const [outcome, count] of byOutcome) output.log(`  ${outcome}: ${count}`)
  }

  return 0
}
