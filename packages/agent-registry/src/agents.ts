import type { AgentEntry, RegistryAgentEntry } from "./types"
import { API_URL_PLACEHOLDER } from "./render"

const LAST_AGENT_REGISTRY_CHECK_DATE = "2026-08-13"

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

const devin: AgentEntry = {
  id: "devin",
  displayName: "Devin",
  docsSlug: "devin",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: [],
  source: {
    checkedOn: "2026-08-13",
    url: "https://docs.devin.ai/work-with-devin/mcp",
  },
  gotchas: [
    "In Devin, open Settings → MCP Marketplace → Add Your Own. Configure the server in that UI; Devin does not document a local JSON configuration file for custom MCP servers.",
    "For LyraShield's remote server, select HTTP (Streamable HTTP), enter the endpoint and Bearer header, save it, then use Test listing tools before enabling it for work.",
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
    "For a user-profile server, run MCP: Open User Configuration or MCP: Add Server. VS Code owns the profile-specific mcp.json path, so do not edit settings.json for MCP configuration.",
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
  stdioStyle: "array-command-environment",
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://dev.opencode.ai/docs/mcp-servers/",
  },
  gotchas: [
    "OpenCode uses single-brace `{env:VAR}` syntax, not `${VAR}`; wrong syntax passes the literal string through.",
    'OpenCode local entries use `type: "local"`, a command array, and `environment`; remote entries use `type: "remote"`.',
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
  stdioStyle: "array-command-environment",
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://kilo.ai/docs/automate/mcp/using-in-kilo-code",
  },
  gotchas: [
    "Kilo Code uses single-brace `{env:VAR}` syntax, not `${VAR}`; wrong syntax passes the literal string through.",
    "Kilo Code's file is JSONC; a JSON.parse/stringify round-trip destroys the user's comments.",
    'Kilo Code local entries use `type: "local"`, a command array, and `environment`; remote entries use `type: "remote"`.',
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
  displayName: "Gemini CLI (legacy → Antigravity)",
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
    "Gemini CLI is being transitioned to Antigravity CLI (agy). Free/Pro/Ultra stopped June 2026; enterprise/Code Assist licenses are unaffected. For new setups use the `antigravity` entry — Antigravity auto-migrates Gemini CLI configs (skills, MCP servers, gemini.md). This entry remains for enterprise-legacy Gemini CLI only.",
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
  vendorCli: {
    command: "amp",
    args: ["mcp", "add", "lyrashield", "--", "npx", "-y", "@lyrashield/mcp@0.2.4"],
  },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://ampcode.com/manual/mcp.md",
  },
  gotchas: [
    "Amp takes no --env flags; the key must be exported in the user's shell profile and inherited by the Amp CLI.",
    "Amp can use global or workspace settings. The CLI command adds an always-available server; use an Agent Skill when the tools should only load for a relevant task.",
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
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { transport: "streamable-http", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: ["OpenClaw skill.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.openclaw.ai/gateway/configuration-reference",
  },
  gotchas: [
    "OpenClaw manages client-side servers with `openclaw mcp add`, `set`, and `configure`, or in its Control UI at /settings/mcp. Do not use mcporter configuration for OpenClaw-managed servers.",
    'For a local server, declare `transport: stdio` explicitly. For Streamable HTTP, use `transport: "streamable-http"`; then run `openclaw mcp doctor --probe` for a live tool-list check.',
  ],
}

const hermes: AgentEntry = {
  id: "hermes",
  displayName: "Hermes",
  docsSlug: "hermes",
  installStrategy: "config-file",
  format: "yaml",
  rootKey: "mcp_servers",
  locations: [{ scope: "global", path: "~/.hermes/config.yaml", sharedByConvention: false }],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference",
  },
  gotchas: [
    "Hermes stores MCP entries under `mcp_servers` in ~/.hermes/config.yaml. It also supports `hermes mcp add` and `hermes mcp test <name>` from the CLI.",
    "Hermes resolves `${env:VAR}` and `${VAR}` in its YAML configuration. Prefer the environment reference over storing a key in config.yaml.",
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

const rooCode: AgentEntry = {
  id: "roo-code",
  displayName: "Roo Code",
  docsSlug: "roo-code",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "project",
      path: ".roo/mcp.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { type: "streamable-http", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: [".roo/rules/lyrashield.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/",
  },
  gotchas: [
    'Remote entries MUST use `type: "streamable-http"` (hyphenated); `type: "http"` or `streamableHttp` fails — Roo validates the literal string.',
    "Project `.roo/mcp.json` overrides the global `mcp_settings.json` in VS Code globalStorage. Entries may carry `alwaysAllow: string[]` and `disabled: boolean`.",
  ],
}

const mimoCode: AgentEntry = {
  id: "mimo-code",
  displayName: "MiMo Code",
  docsSlug: "mimo-code",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcp",
  locations: [
    { scope: "project", path: ".mimicode/mimocode.jsonc", sharedByConvention: false },
    { scope: "global", path: "~/.config/mimocode/mimocode.jsonc", sharedByConvention: false },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  stdioStyle: "array-command-environment",
  transportFields: {
    stdio: { type: "local" },
    "remote-http": { type: "remote", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://mimo.xiaomi.com/mimocode/mcp-servers",
  },
  gotchas: [
    "Root key is `mcp`, not `mcpServers` — using `mcpServers` silently fails.",
    'Local uses `type: "local"` with `command` as an ARRAY (["npx","-y","<cmd>"]) and `environment` (not `command`+`args`+`env`), plus an `enabled` boolean.',
    'Remote uses `type: "remote"` with `url` + `headers` and `enabled`; OAuth is handled automatically.',
  ],
}

const codebuff: AgentEntry = {
  id: "codebuff",
  displayName: "Codebuff",
  docsSlug: "codebuff",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "project",
      path: ".agents/mcp.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio"],
  credential: { kind: "inline-env" },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://www.codebuff.com/",
  },
  gotchas: [
    "Config lives at `.agents/mcp.json` with a `mcpServers` object of `{ command, args, env }`; open-source terminal agent installed via `npm i -g codebuff`.",
    "Only stdio transport is documented, so this entry is stdio-only. Supports `/init` and `/publish` and an agent store.",
  ],
}

const ohMyPi: AgentEntry = {
  id: "oh-my-pi",
  displayName: "Oh-My-Pi",
  docsSlug: "oh-my-pi",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "project",
      path: ".omp/mcp.json",
      sharedByConvention: true,
    },
    {
      scope: "global",
      path: "~/.omp/agent/mcp.json",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  vendorCli: { command: "omp", args: ["mcp", "add"] },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://omp.sh",
  },
  gotchas: [
    "Project config is `.omp/mcp.json`; user config is `~/.omp/agent/mcp.json` (profile-aware at `~/.omp/profiles/<profile>/agent/mcp.json`). Oh-My-Pi also auto-discovers MCP servers from other tools like Claude Code and Cursor.",
    'Remote uses `type: "http"` for Streamable HTTP; stdio `type` may be omitted (default stdio `{command, args, env}`). Supports OAuth via `auth`/`oauth` fields, plus `/mcp add` and `omp plugin`.',
  ],
}

const claudeCodePlugin: AgentEntry = {
  id: "claude-code-agent-plugin",
  displayName: "Claude Code (Agent Plugin)",
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

const cursorPlugin: AgentEntry = {
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

const vscodePlugin: AgentEntry = {
  id: "vscode-agent-plugin",
  displayName: "VS Code (Agent Plugin)",
  docsSlug: "vscode",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    {
      scope: "global",
      path: "~/.lyrashield/plugins/lyrashield",
      sharedByConvention: false,
    },
  ],
  transports: ["remote-http"],
  credential: { kind: "ui-fields" },
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: "2026-08-12",
    url: "https://code.visualstudio.com/docs/agent-customization/agent-plugins",
  },
  gotchas: [
    "VS Code reads the portable root `plugin.json`; there is no VS Code-specific shim directory. Our manifest declares the Agent Plugins 1.0 `$schema`, so VS Code classifies it as Agent Plugins 1.0 and takes MCP servers from the root `mcp.json`.",
    "Auto-registration is NOT wired yet, so this path is a staging copy rather than a discovery path. VS Code only auto-discovers plugins under `~/.copilot/installed-plugins/`; everything else arrives via a configured marketplace, Install-from-Source, or an explicit entry in the `chat.pluginLocations` setting.",
    "Until marketplace or Install-from-Source registration ships, install VS Code through its verified config-file path: `lyrashield install vscode` writes `.vscode/mcp.json`. Agent plugins additionally require the `chat.plugins.enabled` setting.",
    "Authenticate through the client-hosted OAuth flow when connecting the remote MCP server.",
  ],
}

const openaiCodexPlugin: AgentEntry = {
  id: "openai-codex-agent-plugin",
  displayName: "OpenAI Codex (Agent Plugin)",
  docsSlug: "openai-codex",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    {
      scope: "global",
      path: "~/.codex/plugins/lyrashield",
      sharedByConvention: false,
    },
  ],
  transports: ["remote-http"],
  credential: { kind: "ui-fields" },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://developers.openai.com/codex/plugins/build",
  },
  gotchas: [
    "Codex recognizes root `plugin.json` files using the Agent Plugins 1.0 schema and maps them to Codex plugin manifests.",
    "Authenticate through the client-hosted OAuth flow when connecting the remote MCP server.",
  ],
}

const githubCopilotPlugin: AgentEntry = {
  id: "github-copilot-agent-plugin",
  displayName: "GitHub Copilot (Agent Plugin)",
  docsSlug: "github-copilot",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    {
      scope: "global",
      path: "~/.copilot/plugins/lyrashield",
      sharedByConvention: false,
    },
  ],
  transports: ["remote-http"],
  credential: { kind: "ui-fields" },
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.github.com/en/copilot/concepts/agents/about-plugins",
  },
  gotchas: [
    "GitHub Copilot CLI scans each plugin directory for a `plugin.json` manifest at the root.",
    "Authenticate through the client-hosted OAuth flow when connecting the remote MCP server.",
  ],
}

const kiroPlugin: AgentEntry = {
  id: "kiro-agent-plugin",
  displayName: "Kiro (Agent Plugin)",
  docsSlug: "kiro",
  installStrategy: "agent-plugin",
  format: null,
  rootKey: null,
  locations: [],
  pluginLocations: [
    {
      scope: "global",
      path: "~/.kiro/plugins/lyrashield",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio"],
  credential: { kind: "shell-env" },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://kiro.dev/docs/cli/chat/configuration/",
  },
  gotchas: [
    "Merge the exported `.mcp.kiro.json` server into `.kiro/settings/mcp.json` or `~/.kiro/settings/mcp.json`; the staged plugin directory alone does not establish MCP discovery.",
    "Run `lyrashield login --oauth` before installing so the MCP stdio server can read credentials.",
  ],
}

const EXPERIMENTAL_AGENT_IDS = new Set([
  "picode",
  "vscode-agent-plugin",
  "github-copilot-agent-plugin",
])
const PACKAGE_CONFORMANCE_AGENT_IDS = new Set([
  "claude-code-agent-plugin",
  "cursor-agent-plugin",
  "openai-codex-agent-plugin",
  "kiro-agent-plugin",
])

export const AGENTS: readonly RegistryAgentEntry[] = [
  claudeCode,
  cursor,
  devin,
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
  rooCode,
  mimoCode,
  codebuff,
  ohMyPi,
  claudeCodePlugin,
  cursorPlugin,
  vscodePlugin,
  openaiCodexPlugin,
  githubCopilotPlugin,
  kiroPlugin,
].map((agent) => {
  const supportTier =
    agent.id === "gemini-cli"
      ? "DEPRECATED"
      : EXPERIMENTAL_AGENT_IDS.has(agent.id)
        ? "EXPERIMENTAL"
        : "COMPATIBLE"
  const evidence = PACKAGE_CONFORMANCE_AGENT_IDS.has(agent.id)
    ? "PACKAGE_CONFORMANCE"
    : "DOCUMENTATION"

  return {
    ...agent,
    supportTier,
    verification: {
      evidence,
      checkedOn: agent.source?.checkedOn ?? LAST_AGENT_REGISTRY_CHECK_DATE,
      clientVersion: null,
      platforms: [],
      reference:
        evidence === "PACKAGE_CONFORMANCE"
          ? "packages/agent-plugin/src/__tests__/build.test.ts"
          : (agent.source?.url ?? `https://lyrashieldai.com/docs/integrations/${agent.docsSlug}`),
      receipt: null,
    },
  } satisfies RegistryAgentEntry
})
