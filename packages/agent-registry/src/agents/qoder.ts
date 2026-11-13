import type { AgentEntry } from "../types"
import { API_URL_PLACEHOLDER } from "./shared"

export const qoder: AgentEntry = {
  id: "qoder",
  displayName: "Qoder IDE",
  productFamily: { id: "qoder", name: "Qoder" },
  surface: "ide",
  docsSlug: "qoder",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  preferredTransport: "stdio",
  credential: { kind: "ui-fields" },
  nativeCapabilities: ["plugin", "skills", "commands", "rules", "hooks"],
  distribution: {
    channel: "Qoder IDE Plugins and Skills",
    url: "https://docs.qoder.com/extensions/plugins",
    state: "PREPARATION",
  },
  manualInstructions:
    "In Qoder IDE, open Extensions → Connectors to add LyraShield as a custom MCP server, or use Extensions → Plugins/Skills to import a local package once the LyraShield artifact is prepared. Qoder IDE documentation does not establish a stable MCP or standalone skill file path, so configure it through the UI.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.qoder.com/user-guide/chat/model-context-protocol",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.qoder.com/user-guide/chat/model-context-protocol",
    receipt: null,
  },
  gotchas: [
    "Qoder IDE MCP and skill import use Extensions UI; the CLI's `.qoder/settings.json` and `.qoder/skills` paths belong to the separate Qoder CLI surface.",
    "Qoder IDE supports imported plugins bundling skills, MCP, commands, rules and hooks. LyraShield's client package is still in preparation.",
    "Review MCP permissions and connector authentication in the UI before use; this IDE entry does not inherit Qoder CLI's OAuth flow or configuration paths.",
  ],
}

export const qoderCli: AgentEntry = {
  id: "qoder-cli",
  displayName: "Qoder CLI",
  productFamily: { id: "qoder", name: "Qoder" },
  surface: "cli",
  docsSlug: "qoder-cli",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    { scope: "global", path: "~/.qoder/settings.json", sharedByConvention: false },
    { scope: "project", path: ".qoder/settings.json", sharedByConvention: true },
  ],
  transports: ["stdio", "remote-http"],
  preferredTransport: "remote-http",
  remoteAuth: "oauth",
  credential: { kind: "shell-env" },
  transportFields: {
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  nativeCapabilities: ["plugin", "skills", "commands", "hooks"],
  skillLocations: [
    { scope: "project", path: ".qoder/skills", sharedByConvention: true },
    { scope: "global", path: "~/.qoder/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Qoder CLI plugin marketplace and native skills",
    url: "https://docs.qoder.com/cli/plugins-reference",
    state: "PREPARATION",
  },
  manualInstructions:
    "Install the remote MCP entry in `~/.qoder/settings.json` or project `.qoder/settings.json`, then complete authorization with Qoder CLI's documented `qoder mcp auth` flow and verify with `/mcp`. Project settings require approval and load only in trusted directories. LyraShield's Qoder CLI plugin package is still in preparation.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.qoder.com/cli/mcp-reference",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.qoder.com/cli/mcp-reference",
    receipt: null,
  },
  gotchas: [
    "Qoder CLI uses `mcpServers` in `~/.qoder/settings.json` or project `.qoder/settings.json`; project entries require trust and may prompt for approval.",
    "Remote HTTP OAuth is built into Qoder CLI. Use its `qoder mcp auth` command or `/mcp` flow; do not configure a static hosted API key for delegated actions.",
    "Native CLI skills live in `.qoder/skills` and `~/.qoder/skills`. Qoder plugins can bundle MCP, commands, skills, hooks and workflows; the LyraShield plugin listing remains PREPARATION.",
  ],
}
