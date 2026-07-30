import type { AgentEntry } from "./types.js"
import { API_URL_PLACEHOLDER } from "./render.js"

const claudeCode: AgentEntry = {
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
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  vendorCli: { command: "claude", args: ["mcp", "add"] },
  rulesFiles: ["CLAUDE.md"],
  gotchas: [
    "The project `.mcp.json` is shared by convention with the team; never inline a literal API key into it.",
    "`claude mcp add` flag syntax is ambiguous between docs and upstream README; verify the current form before shelling out.",
    "Claude Code also supports `claude mcp add` as a global alternative to editing the shared project file.",
  ],
}

const cursor: AgentEntry = {
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
  gotchas: [
    "The project `.cursor/mcp.json` is shared by convention; never inline a literal API key into it.",
  ],
}

const windsurf: AgentEntry = {
  id: "windsurf",
  displayName: "Windsurf",
  docsSlug: "windsurf",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "global",
      path: "~/.codeium/windsurf/mcp_config.json",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { serverUrl: API_URL_PLACEHOLDER },
  },
  rulesFiles: [".windsurf/rules/lyrashield.md"],
  gotchas: ["Windsurf's remote form uses `serverUrl`, not `url`."],
}

const vscode: AgentEntry = {
  id: "vscode",
  displayName: "VS Code",
  docsSlug: "vscode",
  installStrategy: "config-file",
  format: "json",
  rootKey: "servers",
  locations: [
    {
      scope: "project",
      path: ".vscode/mcp.json",
      sharedByConvention: true,
    },
    {
      scope: "global",
      path: "user settings.json",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    stdio: { type: "stdio" },
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: [".github/copilot-instructions.md"],
  gotchas: [
    "VS Code uses `servers`, not `mcpServers`; using `mcpServers` silently fails.",
    'VS Code stdio entries require `type: "stdio"`; remote entries use `type: "http"`.',
  ],
}

const openaiCodex: AgentEntry = {
  id: "openai-codex",
  displayName: "OpenAI Codex",
  docsSlug: "openai-codex",
  installStrategy: "config-file",
  format: "toml",
  rootKey: "mcp_servers",
  locations: [
    {
      scope: "global",
      path: "~/.codex/config.toml",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio"],
  credential: { kind: "env-names", field: "env_vars" },
  rulesFiles: ["AGENTS.md"],
  gotchas: [
    "OpenAI Codex uses `env_vars`, not `env` — a separate TOML sub-table `[mcp_servers.lyrashield.env_vars]`. Using `env` is silently ignored.",
  ],
}

const cline: AgentEntry = {
  id: "cline",
  displayName: "Cline",
  docsSlug: "cline",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { type: "streamableHttp", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: [".clinerules"],
  gotchas: [
    "The `cline_mcp_settings.json` path is not verified; Cline is documented as managed via the panel.",
    'Cline defaults to legacy SSE when `type` is omitted; the remote endpoint needs `type: "streamableHttp"` explicitly.',
  ],
}

const opencode: AgentEntry = {
  id: "opencode",
  displayName: "OpenCode",
  docsSlug: "opencode",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcp",
  locations: [
    {
      scope: "project",
      path: "opencode.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: {
    kind: "interpolated-env",
    syntax: "{env:LYRASHIELD_API_KEY}",
  },
  transportFields: {
    stdio: { type: "local" },
    "remote-http": { type: "remote", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: ["AGENTS.md"],
  gotchas: [
    "OpenCode uses single-brace `{env:VAR}` syntax, not `${VAR}`; wrong syntax passes the literal string through.",
    'OpenCode entries need `type: "local"` for stdio and `type: "remote"` for remote.',
  ],
}

const kiloCode: AgentEntry = {
  id: "kilo-code",
  displayName: "Kilo Code",
  docsSlug: "kilo-code",
  installStrategy: "config-file",
  format: "jsonc",
  rootKey: "mcp",
  locations: [
    {
      scope: "project",
      path: "kilo.jsonc",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: {
    kind: "interpolated-env",
    syntax: "{env:LYRASHIELD_API_KEY}",
  },
  transportFields: {
    stdio: { type: "local" },
    "remote-http": { type: "remote", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: ["AGENTS.md"],
  gotchas: [
    "Kilo Code uses single-brace `{env:VAR}` syntax, not `${VAR}`; wrong syntax passes the literal string through.",
    "Kilo Code's file is JSONC; a JSON.parse/stringify round-trip destroys the user's comments.",
    'Kilo Code entries need `type: "local"` for stdio and `type: "remote"` for remote.',
  ],
}

const zed: AgentEntry = {
  id: "zed",
  displayName: "Zed",
  docsSlug: "zed",
  installStrategy: "config-file",
  format: "json",
  rootKey: "context_servers",
  locations: [
    {
      scope: "global",
      path: "user settings.json",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio"],
  credential: { kind: "inline-env" },
  commandWrapperKey: "command",
  rulesFiles: ["AGENTS.md"],
  gotchas: [
    "Zed uses `context_servers`, and nests args/env inside a `command` object whose executable field is `path`, not `command`.",
  ],
}

const geminiCli: AgentEntry = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  docsSlug: "gemini-cli",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "global",
      path: "~/.gemini/settings.json",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio"],
  credential: { kind: "inline-env" },
  serverNameConstraint: "Use 'lyrashield' only — no underscores.",
  rulesFiles: ["AGENTS.md"],
  gotchas: [
    "Gemini CLI strips env vars whose names contain KEY, TOKEN or SECRET from subprocess environments; LYRASHIELD_API_KEY must be declared inline in the entry's env block.",
    "Server name must not contain underscores; use `lyrashield`, never `lyra_shield`.",
  ],
}

const jetbrains: AgentEntry = {
  id: "jetbrains",
  displayName: "JetBrains",
  docsSlug: "jetbrains",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  credential: { kind: "ui-fields" },
  rulesFiles: ["AGENTS.md"],
  gotchas: [
    "JetBrains has no file we can write; the MCP server must be configured through the Settings UI.",
  ],
}

const amp: AgentEntry = {
  id: "amp",
  displayName: "Amp",
  docsSlug: "amp",
  installStrategy: "vendor-cli",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  credential: { kind: "shell-env" },
  vendorCli: { command: "amp", args: ["mcp", "add"] },
  rulesFiles: ["AGENTS.md"],
  gotchas: [
    "Amp takes no --env flags; the key must be exported in the user's shell profile and inherited by the Amp CLI.",
    "Amp config is global and CLI-managed; there is no per-project file.",
  ],
}

const picode: AgentEntry = {
  id: "picode",
  displayName: "PiCode",
  docsSlug: "picode",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  credential: { kind: "inline-env" },
  rulesFiles: ["AGENTS.md"],
  gotchas: [
    "PiCode's config file path is not documented in our docs; the `mcpServers` shape is known but the path is not.",
  ],
}

const openclaw: AgentEntry = {
  id: "openclaw",
  displayName: "OpenClaw",
  docsSlug: "openclaw",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  credential: { kind: "inline-env" },
  rulesFiles: ["OpenClaw skill.md"],
  gotchas: [
    "OpenClaw's `mcporter.yaml` resolution order and profile YAML path are not verified.",
    "If promoted to config-file, OpenClaw uses YAML with `mcp_servers` root, stdio transport, and must declare `transport: stdio` explicitly.",
  ],
}

const hermes: AgentEntry = {
  id: "hermes",
  displayName: "Hermes",
  docsSlug: "hermes",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  credential: { kind: "inline-env" },
  rulesFiles: ["AGENTS.md"],
  gotchas: [
    "Hermes' profile YAML path is not documented.",
    "If promoted to config-file, Hermes uses YAML with `mcp_servers` root, stdio transport, and must declare `transport: stdio` explicitly.",
  ],
}

export const AGENTS: readonly AgentEntry[] = [
  claudeCode,
  cursor,
  windsurf,
  vscode,
  openaiCodex,
  cline,
  opencode,
  kiloCode,
  zed,
  geminiCli,
  jetbrains,
  amp,
  picode,
  openclaw,
  hermes,
] as const
