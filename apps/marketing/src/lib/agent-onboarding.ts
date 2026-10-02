import { listPreferredAgents } from "@lyrashield/agent-registry"
import type { AgentEntry } from "@lyrashield/agent-registry"

/**
 * How each install strategy is described to a human. The registry is the source
 * of truth for WHICH clients exist; this only names WHAT the setup feels like.
 */
const STRATEGY_LABEL: Record<AgentEntry["installStrategy"], string> = {
  "agent-plugin": "Agent Plugin",
  "config-file": "Manual config merge",
  "vendor-cli": "Uses the agent's own CLI",
  "guided-manual": "Shows values to paste",
}

const STRATEGY_ORDER: ReadonlyArray<AgentEntry["installStrategy"]> = [
  "agent-plugin",
  "config-file",
  "vendor-cli",
  "guided-manual",
]

interface AgentOnboardingClient {
  name: string
  href: string
  strategy: AgentEntry["installStrategy"]
  strategyLabel: string
  integrationKind: "mcp" | "standalone-cli"
  supportTier: string
  evidence: string
  clientVersion: string | null
  platforms: readonly string[]
  preferredTransport: string | null
}

interface AgentOnboardingClientGroup {
  strategy: AgentEntry["installStrategy"]
  label: string
  clients: AgentOnboardingClient[]
}

/**
 * Every documented client, derived from the agent registry.
 *
 * This used to be a hand-written list of five, which silently drifted: VS Code
 * is a real supported client and a launch Agent Plugin target, yet it was
 * missing from /agents entirely — and so were roughly eighteen others. Deriving
 * from listPreferredAgents() means adding an agent to the registry publishes it
 * here automatically, and the page can never disagree with the docs again.
 *
 * listPreferredAgents() already collapses the plugin/config duplicates down to
 * one entry per documented client, which is exactly the granularity a human
 * choosing their editor wants.
 */
function buildClients(): AgentOnboardingClient[] {
  return listPreferredAgents().map((agent) => ({
    // Registry display names carry an "(Agent Plugin)" suffix to disambiguate
    // the plugin shim from the config-file entry. That distinction matters in
    // the docs registry but is noise on a page where the install strategy is
    // already shown as its own badge.
    name: agent.displayName.replace(/\s*\(Agent Plugin\)$/, ""),
    href: `/docs/integrations/${agent.docsSlug}`,
    strategy: agent.installStrategy,
    strategyLabel:
      agent.integrationKind === "standalone-cli"
        ? "Standalone CLI and CI"
        : agent.installStrategy === "agent-plugin" && agent.manualInstructions
          ? "Manual Agent Plugin setup"
          : STRATEGY_LABEL[agent.installStrategy],
    integrationKind: agent.integrationKind ?? "mcp",
    supportTier: agent.supportTier ?? "COMPATIBLE",
    evidence: agent.verification?.evidence ?? "DOCUMENTATION",
    clientVersion: agent.verification?.clientVersion ?? null,
    platforms: agent.verification?.platforms ?? [],
    preferredTransport: agent.preferredTransport ?? null,
  }))
}

function buildClientGroups(source: AgentOnboardingClient[]): AgentOnboardingClientGroup[] {
  return STRATEGY_ORDER.map((strategy) => ({
    strategy,
    label: STRATEGY_LABEL[strategy],
    clients: source.filter((client) => client.strategy === strategy),
  })).filter((group) => group.clients.length > 0)
}

const clients = buildClients()

export const agentOnboarding = {
  title: "Release assurance for coding agents",
  description:
    "Give your coding agent evidence-backed checks, reviewable fix proposals and a fresh retest before you ship.",
  setupHeading: "Configure published direct MCP",
  setupDescription:
    "This command starts local workspace OAuth. Manually merge the published @lyrashield/mcp@0.2.11 server entry through the client guide. Hosted OAuth starts inside supported clients, including Pi; Aider uses the standalone CLI or CI path. Follow each client guide for activation and verification.",
  commands: ["npx --yes lyrashield@0.2.13 login --oauth"],
  workflow: ["Target", "Review", "Evidence", "Fix proposal", "Retest", "Report"],
  safety: [
    "The published CLI 0.2.13 preview predates Pi's native MCP setup. Follow the current Pi guide at /docs/integrations/pi; updated CLI recipes remain pending release.",
    "Read-only tools are available after workspace authentication.",
    "Fixes are proposals for review, not automatic code changes or merges.",
    "Hosted writes require a browser-confirmed connection grant and execution-time scope checks. Nondelegated callers receive connect_required; local stdio clients use local approval.",
    "Published CLI 0.2.13 config writes remain withheld for config-file clients while the safe-writer fix is pending. Use each client guide to merge only the LyraShield entry, preserving existing settings, comments where supported, and symlinks.",
    "A CLI preview, config entry, or doctor result does not prove client discovery or authentication; restart the client and complete a read-only authenticated call.",
  ],
  clients,
  clientGroups: buildClientGroups(clients),
} as const

function renderWebMcpSection(origin: string): string {
  const pages = [
    { label: "WebMCP Assurance guide", url: `${origin}/webmcp` },
    { label: "WebMCP Security Checker", url: `${origin}/tools/webmcp-security-checker` },
    { label: "WebMCP controls registry", url: `${origin}/webmcp-controls.json` },
  ]
  return [
    "## WebMCP Assurance (public, browser-local)",
    "",
    "WebMCP is a browser-native model-context surface. The public pages below are read-only and run entirely in the browser; they do not create a workspace authorization channel.",
    "",
    ...pages.map(({ label, url }) => `- [${label}](${url})`),
    "",
    "Available public tools:",
    "",
    "- `analyze_webmcp_source` — analyze source files or pasted code for 14 WebMCP controls.",
    "- `prepare_webmcp_rewrite` — prepare a bounded, reviewable rewrite diff from the same analysis.",
    "- `explain_webmcp_assurance` — page-scoped, read-only explanation of published WebMCP topics on /webmcp.",
    "",
    "The checker never auto-merges changes. Rewrites are applied only in memory for review; nothing is uploaded.",
    "",
  ].join("\n")
}

export function renderAgentOnboardingMarkdown(origin: string): string {
  const clientSections = agentOnboarding.clientGroups
    .map((group) =>
      [
        `### ${group.label}`,
        "",
        ...group.clients.map(
          (client) =>
            `- [${client.name}](${origin}${client.href}) — ${client.strategyLabel}; ${client.supportTier.toLowerCase()} (${client.evidence.toLowerCase().replaceAll("_", " ")} evidence)`
        ),
        "",
      ].join("\n")
    )
    .join("\n")

  return [
    `# ${agentOnboarding.title}`,
    "",
    agentOnboarding.description,
    "",
    `## ${agentOnboarding.setupHeading}`,
    "~~~sh",
    ...agentOnboarding.commands,
    "~~~",
    "",
    agentOnboarding.setupDescription,
    "",
    "## Safety boundaries",
    ...agentOnboarding.safety.map((item) => `- ${item}`),
    "",
    `Read the [Agent Plugin guide](${origin}/docs/integrations/agent-plugins).`,
    "",
    renderWebMcpSection(origin),
    `## Documented client workflows (${agentOnboarding.clients.length})`,
    "",
    clientSections,
  ].join("\n")
}
