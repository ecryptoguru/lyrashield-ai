import minimist from "minimist"
import type { AgentEntry } from "@lyrashield/agent-registry"
import { uninstallAgent } from "../installers/install.js"
import type { Output } from "../output.js"

export async function handleUninstall(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    boolean: ["global", "project"],
  })
  const [agentId] = parsed._
  if (!agentId) {
    output.error("usage: lyrashield uninstall <agent>")
    return 2
  }

  const scope = parsed.global ? "global" : parsed.project ? "project" : undefined

  const registry = await import("@lyrashield/agent-registry").catch(
    () => ({}) as Record<string, unknown>
  )
  const getPreferredAgent = (registry as Record<string, unknown>).getPreferredAgent as
    ((id: string) => AgentEntry | undefined) | undefined
  const list = (registry as Record<string, unknown>).listAgents as (() => AgentEntry[]) | undefined
  const arr = (registry as Record<string, unknown>).AGENTS as AgentEntry[] | undefined
  const all = list?.() ?? arr ?? []
  const agent = getPreferredAgent?.(agentId) ?? all.find((a) => a.id === agentId)

  if (!agent) {
    output.error(`Unknown agent: ${agentId}`)
    return 2
  }

  const result = await uninstallAgent(agent, { scope })

  if (output.json) {
    output.result(result)
  } else {
    output.log(`${result.outcome} ${agent.displayName}` + (result.path ? `  (${result.path})` : ""))
    if (result.message) output.notice(result.message)
  }

  return 0
}
