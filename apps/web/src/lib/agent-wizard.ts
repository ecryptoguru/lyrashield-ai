import type { AgentEntry } from "@lyrashield/agent-registry"
import { getAgent, renderConfig } from "@lyrashield/agent-registry"

/**
 * Per-agent integration wizard data model.
 *
 * One typed model drives one generic stepper — never 15 hand-written pages.
 * Config snippets are generated via the registry's renderConfig (per-agent
 * format: json/toml/yaml, correct rootKey + credential style), with a panel
 * fallback for the guided-manual agents that have no config file.
 */

export type WizardStepKind = "install" | "config" | "api-key" | "rules" | "hooks" | "verify"

export interface WizardStep {
  id: string
  kind: WizardStepKind
  title: string
  /** Plain-language one-liner for the step. */
  summary: string
  /** Exact snippet to paste (config step), already per-agent formatted. */
  snippet?: string
  /** Where the snippet goes (config-file agents). */
  snippetPath?: string
  /** One-click command for this step (install / rules / hook). */
  command?: string
  /** Copy-button aria-label when a command/snippet is present. */
  copyLabel?: string
  /** Gotcha / caveat shown as a subtle note. */
  note?: string
}

export interface AgentWizardData {
  agentId: string
  displayName: string
  docsSlug: string
  installStrategy: AgentEntry["installStrategy"]
  steps: WizardStep[]
}

const API_KEY_PLACEHOLDER = "<paste lsk_ key>"

function primaryConfigPath(agent: AgentEntry): string | undefined {
  const loc = agent.locations.find((location) => location.sharedByConvention) ?? agent.locations[0]
  return loc?.path
}

function buildConfigSnippet(agent: AgentEntry, apiUrl: string): string | undefined {
  // renderConfig only supports config-file agents (json/toml/yaml). jsonc agents
  // and guided-manual agents get a fallback handled by the caller.
  if (agent.installStrategy !== "config-file" || agent.format === "jsonc") return undefined
  const supportsRemote = agent.transports.includes("remote-http")
  try {
    // Prefer the local stdio config (works for the most agents); the remote
    // variant is offered as a note for cloud IDEs.
    const rendered = renderConfig(agent, {
      transport: "stdio",
      apiUrl,
      secretMode: "shell",
    })
    return rendered.content + (supportsRemote ? "" : "")
  } catch {
    return undefined
  }
}

function buildRemoteSnippet(agent: AgentEntry, apiUrl: string): string | undefined {
  if (agent.installStrategy !== "config-file" || agent.format === "jsonc") return undefined
  if (!agent.transports.includes("remote-http")) return undefined
  try {
    return renderConfig(agent, {
      transport: "remote-http",
      apiUrl,
      secretMode: "header",
    }).content
  } catch {
    return undefined
  }
}

/**
 * Build the ordered wizard for one agent. Returns null if the agent is unknown.
 * apiUrl is the app API base. Local stdio receives this base; remote MCP
 * clients receive the derived /api/mcp endpoint.
 */
export function buildAgentWizard(agentId: string, apiUrl: string): AgentWizardData | null {
  const agent = getAgent(agentId)
  if (!agent) return null

  const steps: WizardStep[] = []
  const configPath = primaryConfigPath(agent)
  const supportsRemote = agent.transports.includes("remote-http")

  // 1) Install / detect
  if (agent.installStrategy === "vendor-cli" && agent.vendorCli) {
    const vendorCmd = `${agent.vendorCli.command} ${agent.vendorCli.args.join(" ")}`
    steps.push({
      id: "install",
      kind: "install",
      title: "Install",
      summary: `${agent.displayName} manages MCP servers with its own CLI. The LyraShield CLI delegates to it for you.`,
      command: `npx lyrashield install ${agent.id}`,
      copyLabel: `Copy install command for ${agent.displayName}`,
      note: `Under the hood this runs \`${vendorCmd}\`.`,
    })
  } else {
    steps.push({
      id: "install",
      kind: "install",
      title: "Install",
      summary: `Install the LyraShield integration into ${agent.displayName} with one command.`,
      command: `npx lyrashield install ${agent.id}`,
      copyLabel: `Copy install command for ${agent.displayName}`,
      note:
        agent.installStrategy === "guided-manual"
          ? `${agent.displayName} has no config file the CLI can write — the command prints exact values to paste.`
          : undefined,
    })
  }

  // 2) Config. Agent Plugins bundle their MCP configuration, so installation is enough.
  const localSnippet = buildConfigSnippet(agent, apiUrl)
  const remoteSnippet = buildRemoteSnippet(agent, apiUrl)
  if (agent.installStrategy === "agent-plugin") {
    // No manual config step.
  } else if (localSnippet) {
    steps.push({
      id: "config",
      kind: "config",
      title: "Add the MCP config",
      summary: `Paste this into ${configPath ?? "your MCP config"}. The CLI's install command writes it for you — this is the manual path or a reference.`,
      snippet: localSnippet,
      snippetPath: configPath,
      copyLabel: `Copy ${agent.displayName} MCP config`,
      note: remoteSnippet
        ? "For cloud IDEs that can't run a local process, use the remote HTTP config in the next note instead."
        : undefined,
    })
    if (remoteSnippet) {
      steps.push({
        id: "config-remote",
        kind: "config",
        title: "Remote config (cloud IDEs)",
        summary: `For ${agent.displayName} in a cloud IDE (Lovable, Bolt, Replit, v0), use the remote endpoint instead.`,
        snippet: remoteSnippet,
        snippetPath: configPath,
        copyLabel: `Copy ${agent.displayName} remote MCP config`,
      })
    }
  } else {
    // guided-manual / jsonc fallback — point at the agent's UI + endpoint.
    steps.push({
      id: "config",
      kind: "config",
      title: "Add LyraShield in the agent",
      summary: `${agent.displayName} is configured through its own UI. Add a new MCP server and use the endpoint below with a Bearer key.`,
      snippet: supportsRemote
        ? `URL: ${apiUrl}/api/mcp\nAuthorization: Bearer ${API_KEY_PLACEHOLDER}`
        : `Run: npx -y @lyrashield/mcp\nEnv: LYRASHIELD_API_KEY=${API_KEY_PLACEHOLDER}`,
      copyLabel: `Copy ${agent.displayName} connection values`,
      note: agent.gotchas[0],
    })
  }

  // 3) Authentication
  steps.push({
    id: "api-key",
    kind: "api-key",
    title: "Authenticate",
    summary:
      "Recommended: sign in with the read-only OAuth device flow so the CLI and local MCP server can use your selected workspace.",
    command: "lyrashield login --oauth",
    copyLabel: "Copy login command",
    note: "Credentials are stored at ~/.lyrashield/credentials.json. For API-key-only clients, create an lsk_ key in Settings → API keys and run `lyrashield login` instead.",
  })

  // 4) Rules / skills
  if (agent.rulesFiles.length > 0) {
    steps.push({
      id: "rules",
      kind: "rules",
      title: "Install rules / skills",
      summary: `Keep ${agent.displayName}'s LyraShield rules in sync (${agent.rulesFiles.join(", ")}).`,
      command: `lyrashield rules add ${agent.id}`,
      copyLabel: `Copy rules install command for ${agent.displayName}`,
      note: "Remove anytime with `lyrashield rules remove`.",
    })
  }

  // 5) Hooks (optional, pre-commit only — the CLI has no pre-push command today)
  steps.push({
    id: "hooks",
    kind: "hooks",
    title: "Optional: pre-commit gate",
    summary: "Add an advisory pre-commit check that scans your staged diff before you commit.",
    command: "lyrashield hook install",
    copyLabel: "Copy hook install command",
    note: "Advisory only — it warns but won't block. Skippable; delete .git/hooks/pre-commit to remove.",
  })

  // 6) Verify
  steps.push({
    id: "verify",
    kind: "verify",
    title: "Verify it works",
    summary: "Confirm the setup end-to-end, then run your first scan.",
    command: "lyrashield doctor",
    copyLabel: "Copy doctor command",
    note: "Then try `lyrashield scan` in your project.",
  })

  return {
    agentId: agent.id,
    displayName: agent.displayName,
    docsSlug: agent.docsSlug,
    installStrategy: agent.installStrategy,
    steps,
  }
}
