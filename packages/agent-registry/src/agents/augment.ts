import type { AgentEntry } from "../types"
import { API_URL_PLACEHOLDER } from "./shared"

export const auggie: AgentEntry = {
  id: "auggie",
  displayName: "Auggie CLI",
  productFamily: { id: "augment", name: "Augment" },
  surface: "cli",
  docsSlug: "auggie",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [{ scope: "global", path: "~/.augment/settings.json", sharedByConvention: false }],
  transports: ["stdio", "remote-http"],
  preferredTransport: "stdio",
  remoteAuth: "api-key",
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  nativeCapabilities: ["plugin", "skills", "commands", "rules", "hooks"],
  distribution: {
    channel: "Auggie plugin marketplace",
    url: "https://docs.augmentcode.com/cli/plugins",
    state: "PREPARATION",
  },
  manualInstructions:
    "Auggie supports plugins through `/plugins` and `auggie plugin marketplace`, but LyraShield's Auggie marketplace artifact is still in preparation. This install entry writes the documented MCP server map to `~/.augment/settings.json`; use local stdio with the user's LyraShield credential for direct workflows. Auggie's current MCP docs describe static HTTP headers, not hosted OAuth.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.augmentcode.com/cli/integrations",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.augmentcode.com/cli/integrations",
    receipt: null,
  },
  gotchas: [
    'Auggie persists MCP servers in `~/.augment/settings.json`; the documented `auggie mcp add` command also manages this file. HTTP uses a `type: "http"` entry.',
    "Auggie documents bearer headers for HTTP MCP but does not document OAuth for that transport. A hosted API key does not grant hosted mutation delegation; use stdio with a user-scoped credential for that authorization path.",
    "Auggie plugins support skills, commands, rules, hooks and MCP, and also accept Claude Code plugin layouts. LyraShield's Auggie marketplace listing remains PREPARATION.",
  ],
}

export const augmentVSCode: AgentEntry = {
  id: "augment-vscode",
  displayName: "Augment for VS Code",
  productFamily: { id: "augment", name: "Augment" },
  surface: "ide",
  versionConstraints: {
    minimum: "0.789.0",
    note: "Native Skills and custom commands are Public Beta opt-ins on the VS Code extension from 0.789.0; MCP and Rules have separate availability.",
  },
  docsSlug: "augment-vscode",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  preferredTransport: "stdio",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills", "commands", "rules"],
  skillLocations: [
    { scope: "project", path: ".augment/skills", sharedByConvention: true },
    { scope: "global", path: "~/.augment/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Direct Augment IDE skills, commands, rules and MCP settings",
    url: "https://docs.augmentcode.com/using-augment/skills",
    state: "PREPARATION",
  },
  manualInstructions:
    'Augment has no verified LyraShield marketplace listing. Run `npx -y lyrashield@0.2.14 login --oauth`, then add local stdio in Augment Settings → MCP → Import from JSON with command `npx` and args `[\"-y\", \"@lyrashield/mcp@0.2.12\"]`. Install workflow skills with `npx -y lyrashield@0.2.14 skills install augment-vscode`; the installer preserves customized skills. Skills and custom commands require the Public Beta opt-in on VS Code extension 0.789.0 or later. Node.js 24 or later is required. Augment does not document generic OAuth or bearer-header setup for arbitrary remote servers, so use local stdio and the user-only credential store. Preserve existing server entries; verify skill discovery and make a read-only workspace call before treating setup as connected.',
  rulesFiles: [".augment/rules/lyrashield.md", ".augment-guidelines", "AGENTS.md", "CLAUDE.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.augmentcode.com/using-augment/skills",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.augmentcode.com/using-augment/skills",
    receipt: null,
  },
  gotchas: [
    "Skills, commands, MCP servers and rules are configured separately from Auggie CLI plugins. This entry has no persistent MCP config file because the IDE docs provide Settings Panel and JSON import rather than a stable on-disk path.",
    "Custom MCP remote HTTP/SSE configuration is documented, but generic OAuth or bearer-header authentication for arbitrary custom servers is not. Use local stdio with the LyraShield CLI credential store unless Augment documents that auth contract.",
    "VS Code Skills and custom commands are Public Beta opt-ins from extension 0.789.0. User guidelines have a separate VS Code extension version gate; see the official rules guide.",
  ],
}

export const augmentJetBrains: AgentEntry = {
  id: "augment-jetbrains",
  displayName: "Augment for JetBrains",
  productFamily: { id: "augment", name: "Augment" },
  surface: "ide",
  versionConstraints: {
    minimum: "0.428.8",
    note: "Native Skills and custom commands are Public Beta opt-ins on JetBrains extension 0.428.8+; rules have a separate plugin version gate.",
  },
  docsSlug: "augment-jetbrains",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  preferredTransport: "stdio",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills", "commands", "rules"],
  skillLocations: [
    { scope: "project", path: ".augment/skills", sharedByConvention: true },
    { scope: "global", path: "~/.augment/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Direct Augment IDE skills, commands, rules and MCP settings",
    url: "https://docs.augmentcode.com/jetbrains/using-augment/skills",
    state: "PREPARATION",
  },
  manualInstructions:
    'Augment has no verified LyraShield marketplace listing. Run `npx -y lyrashield@0.2.14 login --oauth`, then add local stdio in Augment Settings → MCP → Import from JSON with command `npx` and args `[\"-y\", \"@lyrashield/mcp@0.2.12\"]`. Install workflow skills with `npx -y lyrashield@0.2.14 skills install augment-jetbrains`; the installer preserves customized skills. Skills and custom commands require the Public Beta opt-in on JetBrains extension 0.428.8 or later. Node.js 24 or later is required. Augment does not document generic OAuth or bearer-header setup for arbitrary remote servers, so use local stdio and the user-only credential store. Preserve existing server entries; verify skill discovery and make a read-only workspace call before treating setup as connected.',
  rulesFiles: [".augment/rules/lyrashield.md", ".augment-guidelines", "AGENTS.md", "CLAUDE.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.augmentcode.com/jetbrains/using-augment/skills",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.augmentcode.com/jetbrains/using-augment/skills",
    receipt: null,
  },
  gotchas: [
    "Skills, commands, MCP servers and rules are configured separately from Auggie CLI plugins. This entry has no persistent MCP config file because the IDE docs provide Settings Panel rather than a stable on-disk path.",
    "Custom MCP remote HTTP/SSE configuration is documented, but generic OAuth or bearer-header authentication for arbitrary custom servers is not. Use local stdio with the LyraShield CLI credential store unless Augment documents that auth contract.",
    "JetBrains Skills and custom commands are Public Beta opt-ins from extension 0.428.8; the official docs give no runtime receipt for this registry entry.",
  ],
}
