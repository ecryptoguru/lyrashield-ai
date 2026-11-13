import type { AgentEntry } from "../types"
import {
  API_URL_PLACEHOLDER,
  CLI_PACKAGE_SPEC,
  MCP_PACKAGE_SPEC,
  LAST_AGENT_REGISTRY_CHECK_DATE,
} from "./shared"

export const cursor: AgentEntry = {
  id: "cursor",
  displayName: "Cursor",
  docsSlug: "cursor",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "project",
      path: ".cursor/mcp.json",
      sharedByConvention: true,
    },
    {
      scope: "global",
      path: "~/.cursor/mcp.json",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: [".cursor/rules/lyrashield.mdc", ".cursorrules"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://cursor.com/docs/mcp",
  },
  gotchas: [
    "The project `.cursor/mcp.json` is shared by convention; never inline a literal API key into it.",
  ],
}

export const cursorPlugin: AgentEntry = {
  id: "cursor-agent-plugin",
  displayName: "Cursor (Agent Plugin)",
  docsSlug: "cursor",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    {
      scope: "global",
      path: "~/.cursor/plugins/local/lyrashield",
      sharedByConvention: false,
    },
  ],
  transports: ["remote-http"],
  credential: { kind: "ui-fields" },
  manualInstructions: `The Agent Plugin package 0.1.31 is published and passes the portable MCP schema. Cursor's public listing and authenticated runtime acceptance remain pending; do not install from the mutable marketplace preparation branch. Use the current direct-MCP fallback: merge mcpServers.lyrashield into ~/.cursor/mcp.json or project .cursor/mcp.json with command npx and args ["-y", "${MCP_PACKAGE_SPEC}"], preserving existing entries. Authenticate separately with npx -y ${CLI_PACKAGE_SPEC} login --oauth in the same OS account, reload Cursor, confirm server/tool discovery, then call lyrashield_list_workspaces. See /docs/integrations/cursor.`,
  rulesFiles: [".cursor/rules/lyrashield.mdc"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://cursor.com/docs/plugins",
  },
  gotchas: [
    "Cursor discovers Agent Plugins from `~/.cursor/plugins/local/`; the portable `plugin.json` at the plugin root is the manifest.",
    "Authenticate through the client-hosted OAuth flow when connecting the remote MCP server.",
  ],
}
