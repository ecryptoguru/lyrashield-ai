import type { AgentEntry } from "../types"
import { API_URL_PLACEHOLDER, LAST_AGENT_REGISTRY_CHECK_DATE } from "./shared"

export const devin: AgentEntry = {
  id: "devin",
  displayName: "Devin",
  productFamily: { id: "devin", name: "Devin" },
  surface: "cloud",
  docsSlug: "devin",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: [],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.devin.ai/work-with-devin/mcp",
  },
  gotchas: [
    "In Devin, open Settings → MCP Marketplace → Add Your Own. Configure the server in that UI; Devin does not document a local JSON configuration file for custom MCP servers.",
    "For LyraShield's remote server, select HTTP (Streamable HTTP) and OAuth, enter the endpoint, then use Test listing tools before enabling it for work.",
  ],
}

export const devinDesktop: AgentEntry = {
  id: "devin-desktop",
  aliases: ["windsurf"],
  displayName: "Devin Desktop / Cascade",
  productFamily: { id: "devin", name: "Devin" },
  surface: "desktop",
  docsSlug: "devin-desktop",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "global",
      path: "~/.config/devin/mcp_config.json",
      platform: { win32: "~/AppData/Roaming/devin/mcp_config.json" },
      sharedByConvention: false,
    },
  ],
  transports: ["remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "ui-fields" },
  transportFields: {
    "remote-http": { serverUrl: API_URL_PLACEHOLDER },
  },
  skillLocations: [{ scope: "project", path: ".devin/skills", sharedByConvention: true }],
  nativeCapabilities: ["skills", "hooks"],
  distribution: {
    channel: "Direct MCP and skill setup",
    url: "https://docs.devin.ai/desktop/cascade/mcp",
    state: "DIRECT",
  },
  rulesFiles: [],
  manualInstructions:
    "For Cascade in Devin Desktop, open the MCP config from the Cascade panel and add the LyraShield Streamable HTTP endpoint with OAuth. Add LyraShield skills under `.devin/skills`. This configuration does not apply to cloud Devin or the Devin Local agent.",
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.devin.ai/desktop/cascade/mcp",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.devin.ai/desktop/cascade/mcp",
    receipt: null,
  },
  gotchas: [
    "This surface is Devin Desktop's legacy Cascade agent. The Devin Local agent uses separate CLI configuration; cloud Devin is configured in its web MCP Marketplace.",
    "Teams may disable MCP or restrict servers through allowlists. Cascade has no one-click MCP marketplace; Devin Local uses a separate marketplace.",
    "Cascade skills live in `.devin/skills`; Cascade hooks are separately configured and must remain opt-in.",
  ],
}

export const devinCli: AgentEntry = {
  id: "devin-cli",
  displayName: "Devin CLI",
  productFamily: { id: "devin", name: "Devin" },
  surface: "cli",
  versionConstraints: {
    minimum: "3000.3",
    note: "Dedicated MCP configuration files are supported from Devin CLI v3000.3; older main-config entries migrate on startup.",
  },
  docsSlug: "devin-cli",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "project",
      path: ".devin/mcp_config.local.json",
      sharedByConvention: false,
    },
    {
      scope: "project",
      path: ".devin/mcp_config.json",
      sharedByConvention: true,
    },
    {
      scope: "global",
      path: "~/.config/devin/mcp_config.json",
      platform: { win32: "~/AppData/Roaming/devin/mcp_config.json" },
      sharedByConvention: false,
    },
  ],
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "inline-env" },
  vendorCli: { command: "devin", args: ["mcp", "add"] },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.devin.ai/cli/extensibility/mcp/configuration",
  },
  gotchas: [
    "Devin CLI v3000.3+ uses dedicated mcp_config files; older main-config mcpServers entries migrate on startup. Inspect and migrate an existing legacy entry before adding a duplicate.",
    "Remote HTTP uses a bare url and `devin mcp login lyrashield` for OAuth; stdio remains available. MCP tools are namespaced mcp__<server>__<tool>.",
  ],
}
