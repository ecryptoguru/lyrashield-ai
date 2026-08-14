import { listPreferredAgents } from "@lyrashield/agent-registry"
import type { AgentEntry } from "@lyrashield/agent-registry"

/**
 * How each install strategy is described to a human. The registry is the source
 * of truth for WHICH clients exist; this only names WHAT the setup feels like.
 */
const STRATEGY_LABEL: Record<AgentEntry["installStrategy"], string> = {
  "agent-plugin": "Agent Plugin",
  "config-file": "Writes a config file",
  "vendor-cli": "Uses the agent's own CLI",
  "guided-manual": "Shows values to paste",
}

const STRATEGY_ORDER: ReadonlyArray<AgentEntry["installStrategy"]> = [
  "agent-plugin",
  "config-file",
  "vendor-cli",
  "guided-manual",
]

export interface AgentOnboardingClient {
  name: string
  href: string
  strategy: AgentEntry["installStrategy"]
  strategyLabel: string
}

export interface AgentOnboardingClientGroup {
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
    strategyLabel: STRATEGY_LABEL[agent.installStrategy],
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
    "Give your coding agent evidence-backed checks, reviewable fix proposals, and a fresh retest before you ship.",
  commands: ["npx lyrashield login --oauth", "npx lyrashield init"],
  workflow: ["Target", "Review", "Evidence", "Fix proposal", "Retest", "Report"],
  safety: [
    "Read-only tools are available after workspace authentication.",
    "Fixes are proposals for review, not automatic code changes or merges.",
    "Mutating tools require write scope and explicit human approval outside the agent.",
  ],
  clients,
  clientGroups: buildClientGroups(clients),
} as const

export function renderAgentOnboardingMarkdown(origin: string): string {
  const clientSections = agentOnboarding.clientGroups
    .map((group) =>
      [
        `### ${group.label}`,
        "",
        ...group.clients.map((client) => `- [${client.name}](${origin}${client.href})`),
        "",
      ].join("\n")
    )
    .join("\n")

  return [
    `# ${agentOnboarding.title}`,
    "",
    agentOnboarding.description,
    "",
    "## Setup",
    "~~~sh",
    ...agentOnboarding.commands,
    "~~~",
    "",
    "## Safety boundaries",
    ...agentOnboarding.safety.map((item) => `- ${item}`),
    "",
    `Read the [Agent Plugin guide](${origin}/docs/integrations/agent-plugins).`,
    "",
    `## Supported coding agents (${agentOnboarding.clients.length})`,
    "",
    clientSections,
  ].join("\n")
}
