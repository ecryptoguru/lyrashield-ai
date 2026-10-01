import minimist from "minimist"
import type { AgentEntry } from "@lyrashield/agent-registry"
import { installAgentSkills, removeAgentSkills } from "../installers/skills.js"
import type { Output } from "../output.js"

export async function handleSkills(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    boolean: ["dry-run", "global", "project"],
    string: ["project-root"],
    default: { "project-root": process.cwd() },
  })
  const [subcommand, agentId] = parsed._ as [string | undefined, string | undefined]
  if (!subcommand || !["install", "remove"].includes(subcommand)) {
    output.error(
      "usage: lyrashield skills install|remove <agent> [--project|--global] [--dry-run] [--project-root <dir>]"
    )
    return 2
  }
  if (!agentId) {
    output.error(`usage: lyrashield skills ${subcommand} <agent> [--project|--global]`)
    return 2
  }
  if (parsed.project && parsed.global) {
    output.error("Choose only one of --project or --global.")
    return 2
  }

  const registry = await import("@lyrashield/agent-registry").catch(() => ({}))
  const api = registry as Record<string, unknown>
  const lookup =
    (api.getPreferredAgent as ((id: string) => AgentEntry | undefined) | undefined) ??
    (api.getAgent as ((id: string) => AgentEntry | undefined) | undefined)
  const agent = lookup?.(agentId)
  if (!agent) {
    output.error(`Unknown agent: ${agentId}`)
    return 2
  }

  const result = await (subcommand === "install" ? installAgentSkills : removeAgentSkills)({
    agent,
    scope: parsed.global ? "global" : "project",
    cwd: parsed["project-root"] as string,
    dryRun: parsed["dry-run"],
  })

  if (output.json) {
    output.result(result)
  } else {
    output.log(
      `${result.outcome} ${result.displayName}` + (result.path ? `  (${result.path})` : "")
    )
    for (const action of result.actions) {
      output.log(`${action.action}: ${action.file}` + (action.reason ? ` (${action.reason})` : ""))
    }
    if (result.message) output.notice(result.message)
  }
  return result.outcome === "FAILED" || result.outcome === "PARTIAL" ? 1 : 0
}
