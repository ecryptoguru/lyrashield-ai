import minimist from "minimist"
import type { AgentEntry } from "@lyrashield/agent-registry"
import { addRules, checkRules, removeRules, type RuleOutcome } from "@lyrashield/agent-rules"
import type { Output } from "../output.js"

async function loadRegistry(): Promise<{
  getAgent: (id: string) => AgentEntry | undefined
  listAgents: () => readonly AgentEntry[]
}> {
  const mod = await import("@lyrashield/agent-registry")
    .then((m) => m as Record<string, unknown>)
    .catch(() => ({}) as Record<string, unknown>)
  const list =
    (mod.listAgents as (() => AgentEntry[]) | undefined) ??
    (() => ((mod.AGENTS as AgentEntry[] | undefined) ?? []) as AgentEntry[])
  const getter =
    (mod.getAgent as ((id: string) => AgentEntry | undefined) | undefined) ??
    ((id: string) => list().find((a) => a.id === id))
  return { getAgent: getter, listAgents: list }
}

function summarize(outcomes: RuleOutcome[]): string[] {
  return outcomes.map((o) => {
    const base = `${o.action}: ${o.file}`
    const parts = [base]
    if (o.sha) parts.push(`sha=${o.sha}`)
    if (o.reason) parts.push(`(${o.reason})`)
    if (o.backupPath) parts.push(`backup=${o.backupPath}`)
    return parts.join(" ")
  })
}

export async function handleRules(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    boolean: ["dry-run", "force"],
    string: ["project-root"],
    default: { "project-root": process.cwd() },
  })

  const [subcommand, agentId] = parsed._ as [string | undefined, string | undefined]

  if (!subcommand) {
    output.error(
      "usage: lyrashield rules add|remove|check [<agent>] [--dry-run] [--force] [--project-root <dir>]"
    )
    return 2
  }

  const projectRoot = parsed["project-root"] as string
  const registry = await loadRegistry()

  if (subcommand === "check" && !agentId) {
    let diverged = false
    const all: { agent: string; checks: Awaited<ReturnType<typeof checkRules>> }[] = []
    for (const agent of registry.listAgents()) {
      const checks = await checkRules(agent, { projectRoot })
      if (checks.some((c) => c.state === "diverged")) diverged = true
      all.push({ agent: agent.id, checks })
    }
    if (output.json) {
      output.result(all)
    } else {
      for (const { agent, checks } of all) {
        for (const c of checks) output.log(`${agent} ${c.state}: ${c.file} (${c.format})`)
      }
    }
    return diverged ? 1 : 0
  }

  if (!agentId) {
    output.error(`usage: lyrashield rules ${subcommand} <agent> [...]`)
    return 2
  }

  const agent = registry.getAgent(agentId)
  if (!agent) {
    output.error(`Unknown agent: ${agentId}`)
    return 2
  }

  try {
    if (subcommand === "add") {
      const outcomes = await addRules(agent, {
        projectRoot,
        dryRun: parsed["dry-run"],
        force: parsed.force,
      })
      if (output.json) {
        output.result({ agent: agent.id, outcomes })
      } else {
        for (const line of summarize(outcomes)) output.log(line)
      }
      const failed = outcomes.some((o) => o.action === "refused")
      return failed ? 1 : 0
    }

    if (subcommand === "remove") {
      const outcomes = await removeRules(agent, {
        projectRoot,
        dryRun: parsed["dry-run"],
      })
      if (output.json) {
        output.result({ agent: agent.id, outcomes })
      } else {
        for (const line of summarize(outcomes)) output.log(line)
      }
      return 0
    }

    if (subcommand === "check") {
      const checks = await checkRules(agent, { projectRoot })
      if (output.json) {
        output.result({ agent: agent.id, checks })
      } else {
        for (const c of checks) {
          output.log(`${c.state}: ${c.file} (${c.format})`)
        }
      }
      const diverged = checks.some((c) => c.state === "diverged")
      return diverged ? 1 : 0
    }

    output.error(`Unknown rules subcommand: ${subcommand}`)
    return 2
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err))
    return 1
  }
}
