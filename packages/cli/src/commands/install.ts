import minimist from "minimist"
import type { AgentEntry, Transport } from "@lyrashield/agent-registry"
import { getEffectiveCredentials } from "../credentials.js"
import { installAgent } from "../installers/install.js"
import type { Output } from "../output.js"

export async function handleInstall(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    boolean: ["dry-run", "global", "project", "inline-secret", "yes"],
    string: ["transport"],
    default: { transport: "stdio" },
  })

  const [agentId] = parsed._
  if (!agentId) {
    output.error("usage: lyrashield install <agent>")
    return 2
  }

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

  const result = await installAgent({
    agent,
    transport,
    apiUrl: creds.apiUrl,
    apiKey: creds.credentialKind === "api-key" ? creds.apiKey : undefined,
    useCredentialStore: creds.credentialKind === "oauth",
    scope,
    dryRun: parsed["dry-run"],
    inlineSecret: parsed["inline-secret"],
    yes: parsed.yes,
  })

  if (output.json) {
    output.result(result)
  } else {
    output.log(`${result.outcome} ${agent.displayName}` + (result.path ? `  (${result.path})` : ""))
    if (result.message) output.notice(result.message)
  }

  return result.outcome === "FAILED" ? 1 : 0
}
