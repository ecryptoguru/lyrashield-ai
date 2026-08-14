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
  clients: [
    ["Claude Code", "/docs/integrations/claude-code"],
    ["Cursor", "/docs/integrations/cursor"],
    ["OpenAI Codex", "/docs/integrations/openai-codex"],
    ["GitHub Copilot", "/docs/integrations/github-copilot"],
    ["Kiro", "/docs/integrations/kiro"],
  ],
} as const

export function renderAgentOnboardingMarkdown(origin: string): string {
  const clientLinks = agentOnboarding.clients
    .map(([name, path]) => `- [${name}](${origin}${path})`)
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
    "## Supported coding agents",
    clientLinks,
    "",
  ].join("\n")
}
