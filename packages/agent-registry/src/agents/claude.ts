import type { AgentEntry } from "../types"
import { API_URL_PLACEHOLDER, LAST_AGENT_REGISTRY_CHECK_DATE } from "./shared"

export const claudeCode: AgentEntry = {
  id: "claude-code",
  displayName: "Claude Code",
  docsSlug: "claude-code",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "project",
      path: ".mcp.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  vendorCli: { command: "claude", args: ["mcp", "add"] },
  rulesFiles: ["CLAUDE.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://code.claude.com/docs/en/mcp",
  },
  gotchas: [
    "The project `.mcp.json` is shared by convention with the team; never inline a literal API key into it.",
    "For stdio, `claude mcp add <name> -- <command> [args...]`; for HTTP, `claude mcp add --transport http <name> <url>`.",
    "Use `--scope user` for a global alternative to the shared project file.",
  ],
}

export const claudeDesktop: AgentEntry = {
  id: "claude-desktop",
  displayName: "Claude Desktop (Remote Connector)",
  productFamily: { id: "claude", name: "Claude" },
  surface: "desktop",
  docsSlug: "claude-desktop",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "ui-fields" },
  distribution: {
    channel: "Claude custom remote connector",
    url: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    state: "DIRECT",
  },
  manualInstructions:
    "In Claude Desktop, open Customize → Connectors → + → Add custom connector, enter the LyraShield hosted MCP URL, then connect and complete OAuth. For Team or Enterprise, an Owner must first add the custom connector in Organization settings → Connectors. This uses Anthropic's remote connector service, not a local Desktop Extension.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference:
      "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    receipt: null,
  },
  gotchas: [
    "Claude Desktop remote connectors are brokered from Anthropic's cloud and require a public-reachable MCP server. Local Desktop Extensions are a separate local-only mechanism.",
    "Team and Enterprise workspaces require an Owner to register the custom connector before individual users connect and authenticate.",
  ],
}

export const claudeWeb: AgentEntry = {
  id: "claude-web",
  displayName: "Claude Web (Remote Connector)",
  productFamily: { id: "claude", name: "Claude" },
  surface: "web",
  docsSlug: "claude-web",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "ui-fields" },
  distribution: {
    channel: "Claude custom remote connector",
    url: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    state: "DIRECT",
  },
  manualInstructions:
    "In Claude web, open Customize → Connectors → + → Add custom connector, enter the LyraShield hosted MCP URL, then connect and complete OAuth. For Team or Enterprise, an Owner must first add the custom connector in Organization settings → Connectors. Enable the connector in a conversation through the + menu when needed.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference:
      "https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp",
    receipt: null,
  },
  gotchas: [
    "Claude web remote connectors use Anthropic's cloud MCP proxy and require a public-reachable endpoint. Local MCP servers and Desktop Extensions are not available on web.",
    "Team and Enterprise workspaces require an Owner to register the custom connector before individual users connect and authenticate.",
  ],
}

export const claudeCodePlugin: AgentEntry = {
  id: "claude-code-agent-plugin",
  displayName: "Claude Code (Agent Plugin)",
  productFamily: { id: "claude", name: "Claude" },
  docsSlug: "claude-code",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    {
      scope: "global",
      path: "~/.claude/plugins/lyrashield",
      sharedByConvention: false,
    },
  ],
  transports: ["remote-http"],
  credential: { kind: "ui-fields" },
  manualInstructions:
    "The Agent Plugin package is published, but the Claude Code public listing and authenticated runtime acceptance remain pending. Do not install from the mutable marketplace preparation branch. Use the current guided direct-MCP fallback in `.mcp.json` at /docs/integrations/claude-code; complete local CLI OAuth separately for stdio, then confirm client discovery and an authenticated read-only call.",
  rulesFiles: ["CLAUDE.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://code.claude.com/docs/en/plugins",
  },
  gotchas: [
    "Claude Code may also discover `.claude-plugin/plugin.json`; the package includes a manifest shim in that directory.",
    "Authenticate through the client-hosted OAuth flow when connecting the remote MCP server.",
  ],
}
