import minimist from "minimist"
import type { AgentEntry, Transport } from "@lyrashield/agent-registry"
import { getEffectiveCredentials } from "../credentials.js"
import { installAgent } from "../installers/install.js"
import { detectAgent } from "../installers/detect.js"
import { createClient } from "../client.js"
import type { Output } from "../output.js"

export async function handleConnect(args: string[], output: Output): Promise<number> {
  const parsed = minimist(args, {
    boolean: ["dry-run", "global", "project", "json", "help"],
    string: ["agent", "transport", "workspace"],
    alias: { a: "agent", t: "transport", w: "workspace", h: "help" },
  })

  if (parsed.help) {
    output.log(`Usage: lyrashield connect [options]

Connects an agent to LyraShield with verified configuration and read test.

Options:
  --agent, -a <name>     Target agent identifier (e.g. codex, cursor, claude-desktop)
  --transport, -t <type> Transport to configure (stdio or remote-http)
  --workspace, -w <id>   Target workspace ID
  --dry-run              Preview changes without modifying config files
  --json                 Output results as JSON
  --help, -h             Show this help message`)
    return 0
  }

  const creds = await getEffectiveCredentials()
  if (!creds.apiKey && creds.credentialKind !== "oauth") {
    output.error(
      "No LyraShield credentials found. Please authenticate first using: lyrashield login"
    )
    return 2
  }

  const registry = await import("@lyrashield/agent-registry").catch(
    () => ({}) as Record<string, unknown>
  )
  const list = (registry as Record<string, unknown>).listAgents as (() => AgentEntry[]) | undefined
  const preferred = (registry as Record<string, unknown>).getPreferredAgent as
    ((id: string) => AgentEntry | undefined) | undefined
  const arr = (registry as Record<string, unknown>).AGENTS as AgentEntry[] | undefined
  const allAgents = list?.() ?? arr ?? []

  let selectedAgent: AgentEntry | undefined

  const requestedAgentId = parsed.agent || parsed._[0]
  if (requestedAgentId) {
    const requested = String(requestedAgentId).toLowerCase()
    if (requested === "claude-desktop" || requested === "claude-chat") {
      output.error(
        "Claude Chat custom connectors are configured in Claude under Customize → Connectors. Use the LyraShield hosted MCP URL there; this CLI command configures Claude Code only."
      )
      return 2
    }
    const aliases: Record<string, string> = {
      codex: "openai-codex",
      claude: "claude-code",
      copilot: "github-copilot",
    }
    const resolvedId = aliases[requested] ?? requested
    selectedAgent =
      preferred?.(resolvedId) ?? allAgents.find((a) => a.id.toLowerCase() === resolvedId)
    if (!selectedAgent) {
      output.error(
        `Unknown agent '${requestedAgentId}'. Run 'lyrashield agents' to view supported agents.`
      )
      return 2
    }
  } else {
    // Auto-detect installed agents
    for (const agent of allAgents) {
      const isDetected = await detectAgent(agent)
      if (isDetected) {
        selectedAgent = agent
        break
      }
    }
    if (!selectedAgent) {
      output.error("Could not detect an installed supported agent. Specify --agent <name>.")
      return 2
    }
  }

  if (!selectedAgent) {
    output.error("Could not find or detect a supported agent. Specify --agent <name>.")
    return 2
  }

  const transport = (parsed.transport as Transport) ?? selectedAgent.transports[0] ?? "stdio"

  // Verify API reachability
  let readVerified = false
  let availableWorkspaces: { id: string; name?: string }[] = []
  try {
    const client = await createClient()
    availableWorkspaces = (await client.request("GET", "/workspaces").catch(() => [])) as {
      id: string
      name?: string
    }[]
  } catch {
    readVerified = false
  }

  const requestedWorkspaceId = parsed.workspace || creds.workspaceId
  const activeWorkspaceId = requestedWorkspaceId || availableWorkspaces[0]?.id || null
  readVerified = Boolean(
    activeWorkspaceId && availableWorkspaces.some((workspace) => workspace.id === activeWorkspaceId)
  )

  const scope = parsed.global ? "global" : parsed.project ? "project" : undefined

  // Install agent configuration
  const installResult = await installAgent({
    agent: selectedAgent,
    transport,
    apiUrl: creds.apiUrl,
    apiKey: creds.credentialKind === "api-key" ? creds.apiKey : undefined,
    useCredentialStore: creds.credentialKind === "oauth",
    scope,
    dryRun: parsed["dry-run"],
  })

  const configured = ["CONFIGURED", "ALREADY_CONFIGURED"].includes(installResult.outcome)
  const status = parsed["dry-run"]
    ? "PREVIEW"
    : configured && readVerified
      ? "CONNECTED"
      : configured
        ? "CONFIGURED_UNVERIFIED"
        : installResult.outcome
  const responsePayload = {
    agent: {
      id: selectedAgent.id,
      displayName: selectedAgent.displayName,
      transport,
    },
    connection: {
      status,
      workspaceId: activeWorkspaceId,
      readVerified,
      configFile: installResult.path ?? null,
      dryRun: Boolean(parsed["dry-run"]),
    },
    message: installResult.message ?? "Connection configured successfully.",
  }

  if (output.json) {
    output.result(responsePayload)
  } else {
    if (installResult.outcome === "FAILED") {
      output.error(`Failed to connect ${selectedAgent.displayName}: ${installResult.message}`)
      return 1
    }
    if (parsed["dry-run"]) {
      output.log(`Previewed ${selectedAgent.displayName} (${transport}) configuration`)
    } else if (!configured) {
      output.warn(`${selectedAgent.displayName}: ${installResult.message ?? installResult.outcome}`)
    } else {
      output.log(`✓ Configured ${selectedAgent.displayName} (${transport})`)
    }
    if (installResult.path) output.log(`  Configuration: ${installResult.path}`)
    output.log(`  Read verification: ${readVerified ? "Verified" : "Unverified"}`)
    if (responsePayload.connection.workspaceId) {
      output.log(`  Active workspace: ${responsePayload.connection.workspaceId}`)
    }
  }

  if (installResult.outcome === "FAILED") return 1
  if (parsed["dry-run"]) return 0
  return configured && readVerified ? 0 : 2
}
