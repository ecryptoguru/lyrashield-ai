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

type WizardStepKind = "install" | "config" | "api-key" | "rules" | "hooks" | "verify"

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
  try {
    // Prefer the local stdio config (works for the most agents); the remote
    // variant is offered as a note for cloud IDEs.
    const rendered = renderConfig(agent, {
      transport: "stdio",
      apiUrl,
      secretMode: "shell",
    })
    return rendered.content
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
      secretMode: agent.remoteAuth === "oauth" ? "shell" : "header",
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
  if (agent.integrationKind === "standalone-cli") {
    steps.push({
      id: "install",
      kind: "install",
      title: "Use the standalone workflow",
      summary: agent.manualInstructions ?? "Run LyraShield CLI checks beside this coding agent.",
      command: "npx lyrashield --help",
      copyLabel: "Copy LyraShield CLI help command",
    })
    steps.push({
      id: "verify",
      kind: "verify",
      title: "Verify the CLI or CI check",
      summary:
        "Run a read-only check on an authorized target and retain its result. This client does not have native MCP integration.",
      command: "lyrashield check-diff",
      copyLabel: "Copy check-diff command",
    })
    return {
      agentId: agent.id,
      displayName: agent.displayName,
      docsSlug: agent.docsSlug,
      installStrategy: agent.installStrategy,
      steps,
    }
  }
  const configPath = primaryConfigPath(agent)
  const usesRemoteOAuth = agent.preferredTransport === "remote-http" && agent.remoteAuth === "oauth"

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
      summary: agent.manualInstructions
        ? `Review the manual activation steps for ${agent.displayName}.`
        : `Prepare the LyraShield integration for ${agent.displayName}.`,
      command: `npx lyrashield install ${agent.id}`,
      copyLabel: `Copy install command for ${agent.displayName}`,
      note:
        agent.installStrategy === "guided-manual"
          ? `${agent.displayName} has no config file the CLI can write — the command prints exact values to paste.`
          : undefined,
    })
  }

  // 2) Config and client activation.
  const localSnippet = buildConfigSnippet(agent, apiUrl)
  const remoteSnippet = buildRemoteSnippet(agent, apiUrl)
  if (agent.installStrategy === "agent-plugin") {
    if (agent.manualInstructions) {
      steps.push({
        id: "config",
        kind: "config",
        title: "Activate in the client",
        summary: agent.manualInstructions,
        note: agent.gotchas[0],
      })
    }
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
        ? "Remote HTTP is an alternative; keep an existing local connection unless you choose to migrate."
        : undefined,
    })
    if (remoteSnippet) {
      steps.push({
        id: "config-remote",
        kind: "config",
        title: "Remote HTTP alternative",
        summary: `Use this only if your ${agent.displayName} version supports remote HTTP. Complete its own OAuth flow when offered.`,
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
      summary:
        agent.manualInstructions ??
        `${agent.displayName} uses its own MCP setup UI. Add the connection values below.`,
      snippet:
        agent.preferredTransport === "remote-http"
          ? `URL: ${apiUrl}/api/mcp\nAuthentication: ${usesRemoteOAuth ? "OAuth" : `Bearer ${API_KEY_PLACEHOLDER}`}`
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
    summary: usesRemoteOAuth
      ? `Complete OAuth in ${agent.displayName}, select one workspace and approve the requested access once.`
      : "Sign in with the OAuth device flow so the CLI and local MCP server can use your selected workspace.",
    command: usesRemoteOAuth ? undefined : "lyrashield login --oauth",
    copyLabel: usesRemoteOAuth ? undefined : "Copy login command",
    note: usesRemoteOAuth
      ? "Matching actions then run within your workspace role, connection scope, target access and budget. Reconnect only after revocation, expiry or a scope change."
      : "Credentials are stored at ~/.lyrashield/credentials.json. For API-key-only clients, create an lsk_ key in Settings → API keys and run `lyrashield login` instead.",
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
    note: "Restart the client, confirm the tool list and rules, then call a read-only LyraShield tool in the client. Doctor only checks the local setup.",
  })

  return {
    agentId: agent.id,
    displayName: agent.displayName,
    docsSlug: agent.docsSlug,
    installStrategy: agent.installStrategy,
    steps,
  }
}
