import type { AgentEntry } from "../types"
import { MCP_PACKAGE_SPEC, LAST_AGENT_REGISTRY_CHECK_DATE } from "./shared"

export const amp: AgentEntry = {
  id: "amp",
  displayName: "Amp",
  surface: "cli",
  nativeCapabilities: ["skills"],
  skillLocations: [
    { scope: "project", path: ".agents/skills", sharedByConvention: true },
    { scope: "global", path: "~/.config/agents/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Amp project and personal skills",
    url: "https://ampcode.com/docs/customize/skills",
    state: "DIRECT",
  },
  docsSlug: "amp",
  installStrategy: "vendor-cli",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "shell-env" },
  vendorCli: {
    command: "amp",
    args: ["mcp", "add", "lyrashield", "--", "npx", "-y", MCP_PACKAGE_SPEC],
  },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://ampcode.com/docs/customize/mcp",
  },
  gotchas: [
    "Amp takes no --env flags for its local stdio CLI; use a local OAuth credential or export a key. Remote HTTP/OAuth is a separate client-managed definition.",
    "Amp can use global or workspace settings. The CLI command adds an always-available server; use an Agent Skill when the tools should only load for a relevant task.",
  ],
}

export const kiroPlugin: AgentEntry = {
  id: "kiro-agent-plugin",
  versionConstraints: {
    minimum: "3",
    note: "Kiro CLI supports Powers from v3; this minimum applies to CLI use of the Power, while Kiro IDE support is separate.",
  },
  displayName: "Kiro (Agent Plugin)",
  docsSlug: "kiro",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    {
      scope: "global",
      path: "~/.kiro/powers/lyrashield",
      sharedByConvention: false,
    },
  ],
  nativeCapabilities: ["plugin", "skills", "rules", "hooks"],
  distribution: {
    channel: "Kiro Power",
    url: "https://kiro.dev/powers/submit/",
    state: "PREPARATION",
  },
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "shell-env" },
  manualInstructions:
    "Import the LyraShield Power through Kiro's documented Power import flow and enable it for the workspace; Kiro CLI supports Powers from v3. If the Power cannot be imported on the selected surface/version or you need an MCP-only fallback, run `lyrashield login --oauth` and merge the `lyrashield` entry from `.mcp.kiro.json` into `.kiro/settings/mcp.json` or `~/.kiro/settings/mcp.json`.",
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://kiro.dev/docs/cli/chat/configuration/",
  },
  gotchas: [
    "Import the Kiro Power as the primary setup. The exported `.mcp.kiro.json` merge is a conditional compatibility route when Power import is unavailable; staging a plugin directory alone does not establish MCP discovery.",
    "Kiro also supports remote HTTP/OAuth using a URL-only MCP entry. Keep stdio as the default until the hosted path has a retained client-runtime receipt.",
  ],
}
