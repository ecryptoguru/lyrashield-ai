import type { AgentEntry } from "../types"

export const jetbrains: AgentEntry = {
  id: "jetbrains",
  aliases: ["jetbrains-ai-assistant"],
  displayName: "JetBrains AI Assistant",
  productFamily: { id: "jetbrains", name: "JetBrains" },
  surface: "ide",
  docsSlug: "jetbrains",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  credential: { kind: "ui-fields" },
  distribution: {
    channel: "JetBrains AI Assistant MCP settings and agent skills",
    url: "https://www.jetbrains.com/help/ai-assistant/agents.html",
    state: "DIRECT",
  },
  manualInstructions:
    "Configure the MCP server in Settings → Tools → AI Assistant → Model Context Protocol (MCP). The same MCP settings can be passed to supported Claude Agent and Codex integrations; use their separate registry entries for agent-specific skills and activation steps.",
  rulesFiles: ["AGENTS.md"],
  source: { checkedOn: "2026-10-01", url: "https://www.jetbrains.com/help/ai-assistant/mcp.html" },
  gotchas: [
    "JetBrains AI Assistant has no stable MCP file path; use its Settings UI and review the displayed connection status and tool list.",
    "MCP can be configured for AI Assistant directly. Hosted Claude Agent and Codex have separate entries because their MCP forwarding and skill paths differ.",
    "Organization-managed IDE Services/Central policies can preconfigure servers or prevent users from adding them.",
  ],
}

export const junieIde: AgentEntry = {
  id: "junie",
  displayName: "Junie IDE",
  productFamily: { id: "jetbrains", name: "JetBrains" },
  surface: "ide",
  docsSlug: "junie",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    { scope: "project", path: ".junie/mcp/mcp.json", sharedByConvention: true },
    { scope: "global", path: "~/.junie/mcp/mcp.json", sharedByConvention: false },
  ],
  transports: ["stdio"],
  preferredTransport: "stdio",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills", "commands", "rules", "plugin", "hooks"],
  skillLocations: [
    { scope: "project", path: ".junie/skills", sharedByConvention: true },
    { scope: "global", path: "~/.junie/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Junie extensions and native skills",
    url: "https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html",
    state: "PREPARATION",
  },
  manualInstructions:
    "For Junie in JetBrains IDEs, add the stdio server through Settings → Tools → Junie → MCP Settings, or edit .junie/mcp/mcp.json at project scope and ~/.junie/mcp/mcp.json at user scope. The IDE docs do not establish the remote OAuth flow available in Junie CLI, so use local stdio here. Add skills under .junie/skills or ~/.junie/skills.",
  rulesFiles: [".junie/rules/lyrashield.md", "AGENTS.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html",
    receipt: null,
  },
  gotchas: [
    "Junie IDE MCP files use the mcpServers JSON object. Keep credentials out of shared project files and provide local environment values outside committed configuration.",
    "Junie IDE and Junie CLI have separate entries because only the current CLI guide explicitly documents remote OAuth authorization.",
    "Project settings and skills load only in a trusted project; inspect the IDE connection status and tool list after activation.",
  ],
}

export const junieCli: AgentEntry = {
  id: "junie-cli",
  displayName: "Junie CLI",
  productFamily: { id: "jetbrains", name: "JetBrains" },
  surface: "cli",
  docsSlug: "junie-cli",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    { scope: "project", path: ".junie/mcp/mcp.json", sharedByConvention: true },
    { scope: "global", path: "~/.junie/mcp/mcp.json", sharedByConvention: false },
  ],
  transports: ["stdio", "remote-http"],
  preferredTransport: "remote-http",
  remoteAuth: "oauth",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills", "commands", "rules", "plugin", "hooks"],
  skillLocations: [
    { scope: "project", path: ".junie/skills", sharedByConvention: true },
    { scope: "global", path: "~/.junie/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Junie extensions marketplace and native skills",
    url: "https://junie.jetbrains.com/docs/junie-cli-extensions.html",
    state: "PREPARATION",
  },
  manualInstructions:
    "For Junie CLI, use /mcp to add the remote LyraShield MCP server and complete browser OAuth authorization. The same server can be configured in .junie/mcp/mcp.json or ~/.junie/mcp/mcp.json. Skills are discovered under .junie/skills and ~/.junie/skills; use /skills to verify discovery.",
  rulesFiles: [".junie/rules/lyrashield.md", "AGENTS.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html",
    receipt: null,
  },
  gotchas: [
    "Junie CLI remote OAuth is available through /mcp and browser authorization. Use that flow instead of a static hosted API key.",
    "Project MCP and skill configuration is loaded only after project trust. Untrusted projects use temporary isolated project configuration.",
    "Junie extensions package skills, MCP configurations, commands, guidelines and hooks; the LyraShield extension listing remains PREPARATION.",
  ],
}

export const jetbrainsClaudeAgent: AgentEntry = {
  id: "jetbrains-claude-agent",
  displayName: "JetBrains Claude Agent",
  productFamily: { id: "jetbrains", name: "JetBrains" },
  surface: "ide",
  docsSlug: "jetbrains-claude-agent",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  preferredTransport: "stdio",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills"],
  skillLocations: [{ scope: "project", path: ".claude/skills", sharedByConvention: true }],
  distribution: {
    channel: "JetBrains AI Assistant hosted Claude Agent",
    url: "https://www.jetbrains.com/help/ai-assistant/agent-skills.html",
    state: "DIRECT",
  },
  manualInstructions:
    "Configure the local stdio MCP server in JetBrains AI Assistant → Settings → Tools → Model Context Protocol, then select Claude Agent in AI Assistant. Install project skills under .claude/skills or import them from Claude global skills. Provider login and MCP-server authentication are separate steps.",
  rulesFiles: ["CLAUDE.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://www.jetbrains.com/help/ai-assistant/agents.html",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://www.jetbrains.com/help/ai-assistant/agents.html",
    receipt: null,
  },
  gotchas: [
    "The embedded Claude Agent supports Agent Skills and uses Claude-specific project instructions in CLAUDE.md.",
    "MCP server configuration is shared through AI Assistant settings; the embedded agent provider login does not authenticate the LyraShield MCP connection.",
  ],
}

export const jetbrainsCodexAgent: AgentEntry = {
  id: "jetbrains-codex-agent",
  displayName: "JetBrains Codex Agent",
  productFamily: { id: "jetbrains", name: "JetBrains" },
  surface: "ide",
  docsSlug: "jetbrains-codex-agent",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  preferredTransport: "stdio",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills"],
  skillLocations: [{ scope: "project", path: ".codex/skills", sharedByConvention: true }],
  distribution: {
    channel: "JetBrains AI Assistant hosted Codex agent",
    url: "https://www.jetbrains.com/help/ai-assistant/codex-agent.html",
    state: "DIRECT",
  },
  manualInstructions:
    "Configure the local stdio MCP server in JetBrains AI Assistant → Settings → Tools → Model Context Protocol, then enable Pass custom MCP servers in the Agents settings before selecting Codex. Install project skills under .codex/skills or import them through AI Assistant. Provider login and MCP-server authentication are separate steps.",
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://www.jetbrains.com/help/ai-assistant/codex-agent.html",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://www.jetbrains.com/help/ai-assistant/codex-agent.html",
    receipt: null,
  },
  gotchas: [
    "Codex skills and AGENTS.md are supported in the embedded agent. MCP servers configured in AI Assistant are not exposed until Pass custom MCP servers is enabled.",
    "The embedded Codex provider login is separate from the LyraShield MCP connection; use local stdio credentials for this guided setup.",
  ],
}
