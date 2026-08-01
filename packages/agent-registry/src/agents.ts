import type { AgentEntry } from "./types"
import { API_URL_PLACEHOLDER } from "./render"

const LAST_AGENT_REGISTRY_CHECK_DATE = "2026-07-31"

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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://code.claude.com/docs/en/mcp",
  },
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://cursor.com/docs/mcp",
  },
  gotchas: [
    "The project `.cursor/mcp.json` is shared by convention; never inline a literal API key into it.",
  ],
}

const windsurf: AgentEntry = {
  id: "windsurf",
  displayName: "Devin Desktop (Windsurf)",
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.devin.ai/windsurf/plugins/cascade/mcp",
  },
  gotchas: [
    "Windsurf is now Devin Desktop (June 2026); the config path ~/.codeium/windsurf/mcp_config.json is unchanged. This entry is the Devin Desktop (Cascade) surface — the separate Devin CLI uses .devin/config.local.json (see the devin-cli entry).",
    "Windsurf's remote form uses `serverUrl`, not `url`. Add via the MCP Marketplace UI or View raw config, then click Refresh.",
  ],
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
      path: "~/.config/Code/User/settings.json",
      platform: {
        darwin: "~/Library/Application Support/Code/User/settings.json",
        linux: "~/.config/Code/User/settings.json",
        win32: "~/AppData/Roaming/Code/User/settings.json",
      },
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://code.visualstudio.com/docs/agent-customization/mcp-servers",
  },
  gotchas: [
    "VS Code uses `servers`, not `mcpServers`; using `mcpServers` silently fails.",
    'VS Code stdio entries require `type: "stdio"`; remote entries use `type: "http"`.',
    "Global VS Code settings.json is per-platform; verify the resolved path against your installation.",
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://developers.openai.com/codex/mcp",
  },
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.cline.bot/mcp/mcp-marketplace",
  },
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://dev.opencode.ai/docs/mcp-servers/",
  },
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://kilo.ai/docs/automate/mcp/using-in-kilo-code",
  },
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
      path: "~/.config/zed/settings.json",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio"],
  credential: { kind: "inline-env" },
  commandWrapperKey: "command",
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://zed.dev/docs/ai/mcp",
  },
  gotchas: [
    "Zed uses `context_servers`, and nests args/env inside a `command` object whose executable field is `path`, not `command`.",
    "Zed's global settings path is `~/.config/zed/settings.json`; verify it for your platform.",
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
  forceInlineEnv: true,
  serverNamePattern: "^lyrashield$",
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://github.com/google-gemini/gemini-cli/blob/HEAD/docs/tools/mcp-server.md",
  },
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://www.jetbrains.com/help/ai-assistant/mcp.html",
  },
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://ampcode.com/manual/mcp.md",
  },
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: null,
  },
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.openclaw.ai/gateway/configuration-reference",
  },
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
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference",
  },
  gotchas: [
    "Hermes' profile YAML path is not documented.",
    "If promoted to config-file, Hermes uses YAML with `mcp_servers` root, stdio transport, and must declare `transport: stdio` explicitly.",
  ],
}

const antigravity: AgentEntry = {
  id: "antigravity",
  displayName: "Antigravity",
  docsSlug: "antigravity",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "global",
      path: "~/.gemini/config/mcp_config.json",
      sharedByConvention: true,
    },
    {
      scope: "project",
      path: ".agents/mcp_config.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    // Antigravity uses `serverUrl` (not `url`) for HTTP-based MCP servers.
    "remote-http": { serverUrl: API_URL_PLACEHOLDER },
  },
  rulesFiles: ["GEMINI.md", "AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://antigravity.google/docs/cli/mcp",
  },
  gotchas: [
    "Antigravity uses `serverUrl`, not `url`, for HTTP servers — `url` is rejected.",
    "One shared config at ~/.gemini/config/mcp_config.json serves the IDE, the agy CLI, and 2.0; the workspace .agents/mcp_config.json scopes to one project.",
    "Shared skills live in ~/.gemini/skills; project rules go in GEMINI.md (project) or AGENTS.md (global).",
  ],
}

const copilotCli: AgentEntry = {
  id: "copilot-cli",
  displayName: "GitHub Copilot CLI",
  docsSlug: "copilot-cli",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "global",
      path: "~/.copilot/mcp-config.json",
      sharedByConvention: false,
    },
    {
      scope: "project",
      path: ".mcp.json",
      sharedByConvention: true,
    },
    {
      scope: "project",
      path: ".github/mcp.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    stdio: { type: "local" },
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  vendorCli: { command: "copilot", args: ["mcp", "add"] },
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
  },
  gotchas: [
    'Copilot CLI stdio entries use `type: "local"` (or `"stdio"`); remote uses `type: "http"`.',
    'Each entry may carry a `tools` array (e.g. ["*"]) to allowlist server tools.',
    "GitHub's own MCP server is built in — you don't add it manually.",
  ],
}

const goose: AgentEntry = {
  id: "goose",
  displayName: "Goose",
  docsSlug: "goose",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  rulesFiles: [".goosehints"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://block-goose.mintlify.app/guides/mcp-integration",
  },
  gotchas: [
    "Goose configures MCP servers as `extensions` in ~/.config/goose/config.yaml (YAML, nested map) — not a `mcpServers` JSON dict. Stdio entry: {type: stdio, cmd, args}; remote: {type: streamable_http, uri, headers}.",
    "Goose has no MCP rules file; project hints live in .goosehints.",
  ],
}

const aider: AgentEntry = {
  id: "aider",
  displayName: "Aider",
  docsSlug: "aider",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  rulesFiles: [],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://modelpiper.com/blog/aider-mcp-setup",
  },
  gotchas: [
    "Aider's MCP is configured as a YAML list under `mcp-servers` in ~/.aider.conf.yml (or a `--mcp-servers '<json>'` CLI flag) — not a `mcpServers` JSON dict. Remote entries use `transport: http` + `url`.",
    "Aider has no MCP rules file.",
  ],
}

const devinCli: AgentEntry = {
  id: "devin-cli",
  displayName: "Devin CLI",
  docsSlug: "devin-cli",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "project",
      path: ".devin/config.local.json",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio"],
  credential: { kind: "inline-env" },
  vendorCli: { command: "devin", args: ["mcp", "add"] },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://cognitionai.mintlify.app/cli/extensibility/mcp/overview",
  },
  gotchas: [
    "Devin CLI (separate from Devin Desktop) uses .devin/config.local.json (gitignored) with a mcpServers object; stdio only.",
    "Manage servers with `devin mcp add|login|enable|disable`; remote servers needing OAuth authenticate via `devin mcp login <server>`. MCP tools are namespaced mcp__<server>__<tool>.",
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
  antigravity,
  copilotCli,
  goose,
  aider,
  devinCli,
] as const
