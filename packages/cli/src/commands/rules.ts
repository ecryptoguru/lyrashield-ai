/* eslint-disable security/detect-non-literal-fs-filename */
import minimist from "minimist"
import type { AgentEntry } from "@lyrashield/agent-registry"
import { addRules, checkRules, removeRules, type RuleOutcome } from "@lyrashield/agent-rules"
import type { Output } from "../output.js"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"

async function configuredRulesAgent(agent: AgentEntry, projectRoot: string): Promise<AgentEntry> {
  if (agent.id !== "gemini-cli") return agent
  for (const settingsPath of [
    path.join(projectRoot, ".gemini/settings.json"),
    path.join(homedir(), ".gemini/settings.json"),
  ]) {
    const raw = await readFile(settingsPath, "utf8").catch(() => undefined)
    if (!raw) continue
    const names = (parse(raw) as { context?: { fileName?: string | string[] } })?.context?.fileName
    const selected = (Array.isArray(names) ? names : [names]).find(
      (name): name is string => typeof name === "string" && /^[A-Za-z0-9._-]+\.md$/i.test(name)
    )
    if (selected) return { ...agent, rulesFiles: [selected] }
  }
  return agent
}

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
      const checks = await checkRules(await configuredRulesAgent(agent, projectRoot), { projectRoot })
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

  const requestedAgent = registry.getAgent(agentId)
  if (!requestedAgent) {
    output.error(`Unknown agent: ${agentId}`)
    return 2
  }
  const agent = await configuredRulesAgent(requestedAgent, projectRoot)

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
