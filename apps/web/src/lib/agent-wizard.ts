import type { AgentEntry } from "@lyrashield/agent-registry"
import {
  CLI_PACKAGE_SPEC,
  CLI_CONFIG_WRITES_AVAILABLE,
  CLI_SKILLS_AVAILABLE,
  MCP_PACKAGE_SPEC,
  getAgent,
  getPublishedCliInstallCommand,
  renderConfig,
  renderEntry,
} from "@lyrashield/agent-registry"

/**
 * Per-agent integration wizard data model.
 *
 * One typed model drives one generic stepper — never 15 hand-written pages.
 * Config snippets are generated via the registry's renderConfig (per-agent
 * format: json/toml/yaml, correct rootKey + credential style), with a panel
 * fallback for the guided-manual agents that have no config file.
 */

type WizardStepKind = "install" | "config" | "api-key" | "rules" | "skills" | "hooks" | "verify"

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
  /** Optional alternatives never appear as required setup steps. */
  optional?: boolean
}

export interface AgentWizardData {
  agentId: string
  displayName: string
  docsSlug: string
  installStrategy: AgentEntry["installStrategy"]
  surface: NonNullable<AgentEntry["surface"]> | null
  nativeCapabilities: NonNullable<AgentEntry["nativeCapabilities"]>
  supportTier: NonNullable<AgentEntry["supportTier"]>
  verification: AgentEntry["verification"] | null
  distribution: AgentEntry["distribution"] | null
  versionConstraints: AgentEntry["versionConstraints"] | null
  steps: WizardStep[]
}

function primaryConfigPath(agent: AgentEntry): string | undefined {
  const loc = agent.locations.find((location) => location.sharedByConvention) ?? agent.locations[0]
  return loc?.path
}

function buildConfigSnippet(agent: AgentEntry, apiUrl: string): string | undefined {
  if (agent.installStrategy !== "config-file" || !agent.transports.includes("stdio"))
    return undefined
  try {
    const options = {
      transport: "stdio",
      apiUrl,
      secretMode: "shell",
    } as const
    if (agent.format === "jsonc") {
      const { rootKey, entryKey, value } = renderEntry(agent, options)
      return JSON.stringify({ [rootKey]: { [entryKey]: value } }, null, 2)
    }
    return renderConfig(agent, options).content
  } catch {
    return undefined
  }
}

function buildRemoteSnippet(agent: AgentEntry, apiUrl: string): string | undefined {
  if (agent.installStrategy !== "config-file") return undefined
  if (!agent.transports.includes("remote-http")) return undefined
  try {
    const options = {
      transport: "remote-http",
      apiUrl,
      secretMode: agent.remoteAuth === "oauth" ? "shell" : "header",
    } as const
    if (agent.format === "jsonc") {
      const { rootKey, entryKey, value } = renderEntry(agent, options)
      return JSON.stringify({ [rootKey]: { [entryKey]: value } }, null, 2)
    }
    return renderConfig(agent, options).content
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
  const publishedInstallCommand = getPublishedCliInstallCommand(agent)
  const manualPlugin = agent.installStrategy === "agent-plugin" && !!agent.manualInstructions
  const pendingPluginFallbackId: Record<string, string> = {
    "claude-code-agent-plugin": "claude-code",
    "cursor-agent-plugin": "cursor",
    "openai-codex-agent-plugin": "openai-codex",
    "github-copilot-agent-plugin": "copilot-cli",
    "vscode-agent-plugin": "vscode",
  }
  const pendingPluginFallback = manualPlugin
    ? getAgent(pendingPluginFallbackId[agent.id] ?? "")
    : undefined
  const localSetup = agent.surface !== "cloud" && agent.surface !== "web"
  const augmentWorkflowInPreparation =
    agent.productFamily?.id === "augment" &&
    agent.surface === "ide" &&
    agent.distribution?.state === "PREPARATION"

  const steps: WizardStep[] = []
  const metadata = {
    agentId: agent.id,
    displayName: agent.displayName,
    docsSlug: agent.docsSlug,
    installStrategy: agent.installStrategy,
    surface: agent.surface ?? null,
    nativeCapabilities: agent.nativeCapabilities ?? [],
    supportTier: agent.supportTier ?? "COMPATIBLE",
    verification: agent.verification ?? null,
    distribution: agent.distribution ?? null,
    versionConstraints: agent.versionConstraints ?? null,
  } satisfies Omit<AgentWizardData, "steps">
  if (agent.integrationKind === "standalone-cli") {
    steps.push({
      id: "install",
      kind: "install",
      title: "Use the standalone workflow",
      summary: agent.manualInstructions ?? "Run LyraShield CLI checks beside this coding agent.",
      command: `npx -y ${CLI_PACKAGE_SPEC} --help`,
      copyLabel: "Copy LyraShield CLI help command",
    })
    steps.push({
      id: "verify",
      kind: "verify",
      title: "Verify the CLI or CI check",
      summary:
        "Run a read-only check on an authorized target and retain its result. This client does not have native MCP integration.",
      command: `npx -y ${CLI_PACKAGE_SPEC} check-diff`,
      copyLabel: "Copy check-diff command",
    })
    return {
      ...metadata,
      steps,
    }
  }
  const configPath = primaryConfigPath(agent)
  const usesRemoteOAuth =
    !pendingPluginFallback &&
    agent.preferredTransport === "remote-http" &&
    agent.remoteAuth === "oauth"
  const usesRemoteApiKey =
    !pendingPluginFallback && agent.preferredTransport === "remote-http" && !usesRemoteOAuth
  const remoteOAuthCommand =
    usesRemoteOAuth && agent.id === "picode" ? "pi mcp login lyrashield" : undefined

  // 1) Install / detect
  if (agent.installStrategy === "vendor-cli" && agent.vendorCli) {
    const vendorCmd = `${agent.vendorCli.command} ${agent.vendorCli.args.join(" ")}`
    steps.push({
      id: "install",
      kind: "install",
      title: "Install",
      summary: `${agent.displayName} manages MCP servers with its own CLI. The LyraShield CLI delegates to it for you.`,
      command: publishedInstallCommand ?? undefined,
      copyLabel: `Copy install command for ${agent.displayName}`,
      note: `Under the hood this runs \`${vendorCmd}\`.`,
    })
  } else {
    steps.push({
      id: "install",
      kind: "install",
      title: manualPlugin
        ? "Manual Agent Plugin setup"
        : augmentWorkflowInPreparation
          ? "Connect current MCP tools"
          : publishedInstallCommand
            ? "Install"
            : "Prepare manual setup",
      summary: manualPlugin
        ? "The source installer returns MANUAL_REQUIRED: it prints instructions and does not install or register the plugin. Published CLI behavior may differ until release. Follow the client activation steps below; discovery, authentication and a read-only call must each be confirmed."
        : agent.id === "picode"
          ? `${agent.manualInstructions} The published CLI 0.2.13 preview predates Pi's native MCP setup. Use these current instructions; updated CLI recipes remain pending release.`
          : augmentWorkflowInPreparation
            ? `The published direct-MCP baseline uses ${CLI_PACKAGE_SPEC} and ${MCP_PACKAGE_SPEC}; it provides MCP tools only. Native workflow skills, commands and rules require the coordinated candidate release.`
            : !publishedInstallCommand
              ? agent.installStrategy === "config-file" && !CLI_CONFIG_WRITES_AVAILABLE
                ? "Automatic config writes are withheld until the preservation fixes ship in the next CLI release. Merge the connection values below into your existing client config."
                : "CLI installation for this setup is prepared for the next release. Use the manual connection steps below."
              : agent.manualInstructions
                ? `Follow the documented activation steps for ${agent.displayName}.`
                : `Prepare the LyraShield integration for ${agent.displayName}.`,
      command: publishedInstallCommand ?? undefined,
      copyLabel: `Copy install command for ${agent.displayName}`,
      note:
        agent.installStrategy === "guided-manual"
          ? publishedInstallCommand
            ? `${agent.displayName} has no config file the CLI can write — the command prints exact values to paste.`
            : `${agent.displayName} uses its documented MCP setup UI. Follow the connection steps below.`
          : undefined,
    })
  }

  // 2) Config and client activation.
  const localSnippet = buildConfigSnippet(agent, apiUrl)
  const remoteSnippet = buildRemoteSnippet(agent, apiUrl)
  const primarySnippet = agent.preferredTransport === "remote-http" ? remoteSnippet : localSnippet
  const alternateSnippet = agent.preferredTransport === "remote-http" ? localSnippet : remoteSnippet
  const alternateAuthNote =
    agent.preferredTransport === "remote-http"
      ? `This local alternative uses a separate credential store. Run \`npx -y ${CLI_PACKAGE_SPEC} login --oauth\` before starting the local server; client OAuth authenticates only the remote connection.`
      : agent.remoteAuth === "oauth"
        ? "Complete OAuth inside this client for the remote alternative. CLI OAuth authenticates only local stdio. Hosted scans require an explicit browser-confirmed delegation."
        : "The remote alternative requires a separate read-only API key from a workspace Owner or Admin, stored in the client's private secret or header settings. CLI OAuth authenticates only local stdio. Never commit a key or paste it into an agent prompt. Hosted mutations return connect_required without a valid OAuth delegation."
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
  } else if (primarySnippet) {
    steps.push({
      id: "config",
      kind: "config",
      title: "Add the MCP config",
      summary: `Merge this server entry into ${configPath ?? "your MCP config"}, preserving existing servers and comments.${publishedInstallCommand ? " The install command above can do this for you." : ""}`,
      snippet: primarySnippet,
      snippetPath: configPath,
      copyLabel: `Copy ${agent.displayName} MCP config`,
      note: alternateSnippet
        ? `This is the preferred ${agent.preferredTransport === "remote-http" ? "remote HTTP/OAuth" : "local stdio"} setup. The alternate transport below is optional.`
        : undefined,
    })
    if (alternateSnippet) {
      steps.push({
        id: agent.preferredTransport === "remote-http" ? "config-local" : "config-remote",
        kind: "config",
        title:
          agent.preferredTransport === "remote-http"
            ? "Local stdio alternative"
            : "Remote HTTP alternative",
        summary:
          agent.preferredTransport === "remote-http"
            ? `Use this only if you prefer a local process and your ${agent.displayName} setup supports stdio.`
            : `Use this only if your ${agent.displayName} version supports remote HTTP. Complete its own OAuth flow when offered.`,
        snippet: alternateSnippet,
        snippetPath: configPath,
        copyLabel: `Copy ${agent.displayName} alternate MCP config`,
        note: alternateAuthNote,
        optional: true,
      })
    }
  } else {
    // Guided clients use their own UI rather than a guessed config file.
    steps.push({
      id: "config",
      kind: "config",
      title: "Add LyraShield in the agent",
      summary:
        agent.manualInstructions ??
        `${agent.displayName} uses its own MCP setup UI. Add the connection values below.`,
      snippet:
        agent.preferredTransport === "remote-http"
          ? `URL: ${apiUrl}/api/mcp\nAuthentication: ${usesRemoteOAuth ? "OAuth" : "read-only API key in the client's private secret settings"}`
          : `Run: npx -y ${MCP_PACKAGE_SPEC}\nEnvironment: LYRASHIELD_API_URL=${apiUrl}\nCredentials: selected CLI workspace`,
      copyLabel: `Copy ${agent.displayName} connection values`,
      note: agent.gotchas[0],
    })
    if (agent.transports.includes("stdio") && agent.transports.includes("remote-http")) {
      const alternativeIsLocal = agent.preferredTransport === "remote-http"
      steps.push({
        id: alternativeIsLocal ? "config-local" : "config-remote",
        kind: "config",
        title: alternativeIsLocal ? "Local stdio alternative" : "Remote HTTP alternative",
        summary: "Use this alternative only through this client's documented MCP setup UI.",
        snippet: alternativeIsLocal
          ? `Run: npx -y ${MCP_PACKAGE_SPEC}\nEnvironment: LYRASHIELD_API_URL=${apiUrl}\nCredentials: selected CLI workspace`
          : `URL: ${apiUrl}/api/mcp\nAuthentication: ${agent.remoteAuth === "oauth" ? "OAuth" : "read-only API key in the client's private secret settings"}`,
        copyLabel: `Copy ${agent.displayName} alternate connection values`,
        note: alternateAuthNote,
        optional: true,
      })
    }
  }

  if (pendingPluginFallback) {
    steps.push({
      id: "config-mcp-fallback",
      kind: "config",
      title: "Current direct MCP fallback",
      summary:
        "Merge this published pinned stdio connection, preserving existing client settings. Plugin installation and skills remain pending a reviewed immutable release.",
      snippet: buildConfigSnippet(pendingPluginFallback, apiUrl),
      snippetPath:
        pendingPluginFallback.locations.find((location) => location.scope === "global")?.path ??
        primaryConfigPath(pendingPluginFallback),
      copyLabel: "Copy current MCP fallback",
      note: "Authenticate with the local CLI separately, restart the client, confirm server and tool discovery, then call lyrashield_list_workspaces to verify authorized access.",
    })
  }

  // 3) Authentication
  steps.push({
    id: "api-key",
    kind: "api-key",
    title: augmentWorkflowInPreparation ? "Authenticate current MCP server" : "Authenticate",
    summary: usesRemoteApiKey
      ? "Ask a workspace Owner or Admin for a read-only API key from Settings → API keys. Store it only in the client's private secret settings, then add it to the connection."
      : remoteOAuthCommand
        ? `Run the Pi OAuth login, select one workspace and approve the requested access once.`
        : usesRemoteOAuth
          ? `Complete OAuth in ${agent.displayName}, select one workspace and approve the requested access once.`
          : "Sign in through CLI OAuth in the same OS account so the local MCP server can use your selected workspace.",
    command: usesRemoteApiKey
      ? undefined
      : usesRemoteOAuth
        ? remoteOAuthCommand
        : `npx -y ${CLI_PACKAGE_SPEC} login --oauth`,
    copyLabel: usesRemoteApiKey
      ? undefined
      : usesRemoteOAuth
        ? remoteOAuthCommand
          ? "Copy Pi OAuth login command"
          : undefined
        : "Copy login command",
    note: usesRemoteApiKey
      ? "This connection uses read-only API-key access. Hosted mutations return connect_required; an API key cannot replace browser-confirmed OAuth delegation. Use an OAuth-capable client for delegated scan and retest workflows. Never commit a key or paste it into an agent prompt."
      : usesRemoteOAuth
        ? "OAuth starts with read-only access. Scans and other hosted mutations require an explicit browser-confirmed delegation for the workflow, target and scan depth; the server rechecks it at execution. Reconnect after revocation, expiry or a scope change."
        : `Credentials are stored at ~/.lyrashield/credentials.json. For API-key-only local clients, create a scoped key in Settings → API keys and run \`npx -y ${CLI_PACKAGE_SPEC} login\` instead.`,
  })

  // 4) Rules / skills
  const pluginProvidesSkills = agent.installStrategy === "agent-plugin"
  if (agent.rulesFiles.length > 0 && !pluginProvidesSkills) {
    steps.push({
      id: "rules",
      kind: "rules",
      title: "Install rules",
      summary: `Keep ${agent.displayName}'s LyraShield rules in sync (${agent.rulesFiles.join(", ")}).`,
      command: publishedInstallCommand
        ? `npx -y ${CLI_PACKAGE_SPEC} rules add ${agent.id}`
        : undefined,
      copyLabel: `Copy rules install command for ${agent.displayName}`,
      note: publishedInstallCommand
        ? `Remove LyraShield-owned rules with \`npx -y ${CLI_PACKAGE_SPEC} rules remove ${agent.id}\`.`
        : "Rules installation for this client is prepared for the next CLI release. Follow the client guide for manual setup.",
    })
  }

  if (agent.skillLocations?.length && !pluginProvidesSkills) {
    steps.push({
      id: "skills",
      kind: "skills",
      title: "Native workflow skills",
      summary: augmentWorkflowInPreparation
        ? "The published MCP baseline provides direct tools only. Native workflow skills are in preparation and will be available after the coordinated candidate release."
        : CLI_SKILLS_AVAILABLE
          ? "Install the focused LyraShield workflows in this client's documented skill directory. Existing customized skills are preserved."
          : "The focused LyraShield skill bundle is prepared for the next release. You can use the connected MCP tools directly in the meantime.",
      command: CLI_SKILLS_AVAILABLE
        ? `npx -y ${CLI_PACKAGE_SPEC} skills install ${agent.id}`
        : undefined,
      copyLabel: `Copy skills install command for ${agent.displayName}`,
      note: CLI_SKILLS_AVAILABLE
        ? `Remove only LyraShield-owned skills with \`npx -y ${CLI_PACKAGE_SPEC} skills remove ${agent.id}\`.`
        : "Client skill discovery is documented; package publication and runtime acceptance are separate checks.",
    })
  }

  // 6) Verify
  steps.push({
    id: "verify",
    kind: "verify",
    title: "Verify it works",
    summary: augmentWorkflowInPreparation
      ? "Confirm the current MCP connection with a read-only LyraShield call. Native workflow skills remain a separate, unpublished release. Scans remain explicit."
      : "Confirm the setup and make a read-only LyraShield call. Scans remain explicit.",
    command: localSetup ? `npx -y ${CLI_PACKAGE_SPEC} doctor` : undefined,
    copyLabel: "Copy doctor command",
    note: "Reload the client connection, confirm its LyraShield tools and available native workflows, then make a read-only call to list authorized targets in your selected workspace. Doctor only checks local setup; it does not establish authenticated client acceptance.",
  })

  if (localSetup) {
    steps.push({
      id: "hooks",
      kind: "hooks",
      optional: true,
      title: "Optional: advisory pre-commit check",
      summary:
        "Run a local staged-diff check before commits. This is separate from recorded scans and does not start paid work.",
      note: `Off by default. The safer offline hook installer is prepared for the next release. Until then, run \`npx -y ${CLI_PACKAGE_SPEC} check-diff --staged\` explicitly. Remove only LyraShield-owned commands from an existing hook and preserve every unrelated command. Never delete a user-owned hook.`,
    })
  }

  // The published CLI requires credentials before installing stdio configs.
  // Keep the first copyable command usable on a fresh machine.
  if (agent.preferredTransport === "stdio" && agent.installStrategy !== "agent-plugin") {
    const authenticationIndex = steps.findIndex((step) => step.kind === "api-key")
    const [authentication] = steps.splice(authenticationIndex, 1)
    if (authentication) steps.unshift(authentication)
  }

  return {
    ...metadata,
    steps,
  }
}
