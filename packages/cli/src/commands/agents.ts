import type { AgentEntry } from "@lyrashield/agent-registry"
import { detectAgent, findDetectedLocations } from "../installers/detect.js"
import type { Output } from "../output.js"

export async function handleAgents(_args: string[], output: Output): Promise<number> {
  const registry = await import("@lyrashield/agent-registry").catch(
    () => ({}) as Record<string, unknown>
  )
  const list = (registry as Record<string, unknown>).listAgents as (() => AgentEntry[]) | undefined
  const arr = (registry as Record<string, unknown>).AGENTS as AgentEntry[] | undefined
  const agents = list?.() ?? arr ?? []

  if (!agents.length) {
    output.warn("Agent registry is not available.")
    return 0
  }

  const rows = await Promise.all(
    agents.map(async (agent) => {
      const detected = await detectAgent(agent)
      const locations = await findDetectedLocations(agent)
      const configured = locations.some((l) => l.hasEntry)
      return {
        id: agent.id,
        displayName: agent.displayName,
        detected,
        configured,
        strategy: agent.installStrategy,
      }
    })
  )

  if (output.json) {
    output.result(rows)
  } else {
    output.log("Agent          Detected  Configured  Strategy")
    for (const r of rows) {
      const d = r.detected ? "yes" : "no"
      const c = r.configured ? "yes" : "no"
      output.log(`${r.id.padEnd(14)} ${d.padEnd(9)} ${c.padEnd(11)} ${r.strategy}`)
    }
  }
  return 0
}
