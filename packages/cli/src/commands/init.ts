import minimist from "minimist"
import type { AgentEntry, Transport } from "@lyrashield/agent-registry"
import { getEffectiveCredentials } from "../credentials.js"
import { installAgent } from "../installers/install.js"
import type { InstallAgentResult } from "../installers/install.js"
import type { Output } from "../output.js"

// Internal outcome codes are precise but SHOUTY_SNAKE_CASE is not a user
// interface. The JSON output keeps the raw codes for machines; humans get these.
const OUTCOME_LABELS: Record<string, string> = {
  CONFIGURED: "configured",
  ALREADY_CONFIGURED: "already set up",
  DELEGATED: "handed to vendor CLI",
  MANUAL_REQUIRED: "needs manual setup",
  NOT_DETECTED: "not installed",
  FAILED: "failed",
}

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome.toLowerCase().replace(/_/g, " ")
}

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
    output.error(
      "No LyraShield credential. Run: lyrashield login --oauth, or use an API key for CI."
    )
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
  const listPreferred = (registry as Record<string, unknown>).listPreferredAgents as
    (() => AgentEntry[]) | undefined
  const getPreferredAgent = (registry as Record<string, unknown>).getPreferredAgent as
    ((id: string) => AgentEntry | undefined) | undefined
  const arr = (registry as Record<string, unknown>).AGENTS as AgentEntry[] | undefined
  const allAgents = list?.() ?? arr ?? []

  if (!allAgents.length) {
    output.error("Agent registry is not available.")
    return 1
  }

  let agents = listPreferred?.() ?? allAgents
  if (selectedAgents.length) {
    agents = selectedAgents
      .map((id) => getPreferredAgent?.(id) ?? allAgents.find((agent) => agent.id === id))
      .filter((agent): agent is AgentEntry => Boolean(agent))
    const missing = selectedAgents.filter(
      (id) => !(getPreferredAgent?.(id) ?? allAgents.find((agent) => agent.id === id))
    )
    if (missing.length) {
      output.warn(`Unknown agent(s): ${missing.join(", ")}`)
    }
  }

  const results: InstallAgentResult[] = []
  // Install Agent Plugin entries first so the portable plugin is in place
  // before any legacy per-client config installers run.
  const pluginAgents = agents.filter((a) => a.installStrategy === "agent-plugin")
  const legacyAgents = agents.filter((a) => a.installStrategy !== "agent-plugin")
  const orderedAgents = [...pluginAgents, ...legacyAgents]

  for (const agent of orderedAgents) {
    const result = await installAgent({
      agent,
      transport,
      apiUrl: creds.apiUrl,
      apiKey: creds.credentialKind === "api-key" ? creds.apiKey : undefined,
      useCredentialStore: creds.credentialKind === "oauth",
      scope,
      all: parsed.all,
      dryRun: parsed["dry-run"],
      inlineSecret: parsed["inline-secret"],
      yes: parsed.yes,
    })
    results.push(result)
    if (!output.json) {
      const status = outcomeLabel(result.outcome).padEnd(20)
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
    for (const [outcome, count] of byOutcome) output.log(`  ${outcomeLabel(outcome)}: ${count}`)
  }

  return 0
}
