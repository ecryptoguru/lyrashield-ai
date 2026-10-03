import type { AgentEntry } from "../types"
import { API_URL_PLACEHOLDER, LAST_AGENT_REGISTRY_CHECK_DATE } from "./shared"

export const cline: AgentEntry = {
  id: "cline",
  displayName: "Cline",
  surface: "ide",
  nativeCapabilities: ["skills"],
  skillLocations: [
    { scope: "project", path: ".cline/skills", sharedByConvention: true },
    { scope: "global", path: "~/.cline/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Direct Cline skills and MCP setup",
    url: "https://github.com/cline/skills",
    state: "DIRECT",
  },
  docsSlug: "cline",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "global",
      path: "~/.cline/data/settings/cline_mcp_settings.json",
      sharedByConvention: false,
    },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { type: "streamableHttp", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: [".clinerules"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.cline.bot/mcp/mcp-overview",
  },
  gotchas: [
    "Cline CLI reads `~/.cline/data/settings/cline_mcp_settings.json` (override with `CLINE_MCP_SETTINGS_PATH`); IDE extensions expose their own MCP settings JSON through the Cline panel.",
    'Cline defaults to legacy SSE when `type` is omitted; the remote endpoint needs `type: "streamableHttp"` explicitly.',
  ],
}

export const kiloCode: AgentEntry = {
  id: "kilo-code",
  displayName: "Kilo Code",
  surface: "ide",
  nativeCapabilities: ["skills"],
  skillLocations: [
    { scope: "project", path: ".kilo/skills", sharedByConvention: true },
    { scope: "global", path: "~/.kilo/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Kilo MCP marketplace with companion skills",
    url: "https://kilo.ai/docs/customize/marketplace",
    state: "PREPARATION",
  },
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
    'Kilo Code local entries use `type: "local"`, a command array and `environment`; remote entries use `type: "remote"`.',
  ],
}

export const zed: AgentEntry = {
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
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "inline-env" },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://zed.dev/docs/ai/mcp",
  },
  gotchas: [
    "Current Zed settings use flat command, args and env fields under context_servers. Legacy nested command.path entries should be updated through Zed settings.",
    "A remote URL without an Authorization header starts Zed's OAuth flow. Keep existing stdio connections unless you deliberately migrate.",
    "Zed's global settings path is `~/.config/zed/settings.json`; verify it for your platform.",
  ],
}

export const geminiCli: AgentEntry = {
  id: "gemini-cli",
  displayName: "Gemini CLI",
  surface: "cli",
  nativeCapabilities: ["skills"],
  skillLocations: [
    { scope: "project", path: ".gemini/skills", sharedByConvention: true },
    { scope: "global", path: "~/.gemini/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Gemini CLI extension with bundled skills",
    url: "https://geminicli.com/docs/extensions/",
    state: "PREPARATION",
  },
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
  transports: ["stdio", "remote-http"],
  credential: { kind: "interpolated-env", syntax: "$LYRASHIELD_API_KEY" },
  transportFields: {
    "remote-http": { httpUrl: API_URL_PLACEHOLDER },
  },
  serverNamePattern: "^lyrashield$",
  rulesFiles: ["GEMINI.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://geminicli.com/docs/tools/mcp-server/",
  },
  gotchas: [
    "GEMINI.md is the default context file. If context.fileName is customized in settings.json, use one of those configured filenames instead.",
    "Gemini CLI expands `$VAR_NAME` and `${VAR_NAME}` references in MCP `env` and `headers`; use a reference instead of a literal secret.",
    "Streamable HTTP servers use `httpUrl`; the `url` field is for SSE endpoints.",
    "Server name must not contain underscores; use `lyrashield`, never `lyra_shield`.",
  ],
}

export const picode: AgentEntry = {
  id: "picode",
  aliases: ["pi"],
  displayName: "Pi",
  surface: "cli",
  docsSlug: "pi",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    { scope: "global", path: "~/.pi/agent/mcp.json", sharedByConvention: false },
    { scope: "project", path: ".pi/mcp.json", sharedByConvention: true },
  ],
  transports: ["stdio", "remote-http"],
  preferredTransport: "remote-http",
  remoteAuth: "oauth",
  credential: { kind: "shell-env" },
  transportFields: {
    "remote-http": { url: API_URL_PLACEHOLDER },
  },
  nativeCapabilities: ["skills"],
  skillLocations: [
    { scope: "global", path: "~/.pi/agent/skills", sharedByConvention: false },
    { scope: "project", path: ".pi/skills", sharedByConvention: true },
  ],
  distribution: {
    channel: "Pi packages (npm or git)",
    url: "https://pi.dev/docs/latest/packages",
    state: "PREPARATION",
  },
  manualInstructions:
    "Use Pi's built-in MCP client: add the hosted server with `pi mcp add lyrashield --url https://app.lyrashieldai.com/api/mcp`, then sign in with `pi mcp login lyrashield`. Install LyraShield's shared workflow skills with `npx -y lyrashield@0.2.14 skills install pi`, then confirm they appear in Pi's skills list. Keep project MCP configuration and skills under project trust; Pi stores OAuth credentials separately.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://pi.dev/docs/latest/mcp",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://pi.dev/docs/latest/mcp",
    receipt: null,
  },
  gotchas: [
    "Pi has built-in MCP and OAuth. User servers belong in `~/.pi/agent/mcp.json`; project servers belong in `.pi/mcp.json` and load only after project trust is granted.",
    "Pi stores OAuth credentials separately from mcp.json. A third-party MCP adapter can replace the built-in MCP support; check `pi mcp list` if configured servers do not load. Pi also discovers shared `.agents/skills` paths, but this installer targets its native user/project skill directories.",
  ],
}

export const hermes: AgentEntry = {
  id: "hermes",
  displayName: "Hermes",
  docsSlug: "hermes",
  installStrategy: "config-file",
  format: "yaml",
  rootKey: "mcp_servers",
  locations: [{ scope: "global", path: "~/.hermes/config.yaml", sharedByConvention: false }],
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "interpolated-env", syntax: "${env:LYRASHIELD_API_KEY}" },
  transportFields: {
    "remote-http": { url: API_URL_PLACEHOLDER, auth: "oauth" },
  },
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

export const antigravity: AgentEntry = {
  id: "antigravity",
  displayName: "Antigravity",
  surface: "ide",
  docsSlug: "antigravity",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    {
      scope: "global",
      path: "~/.gemini/config/mcp_config.json",
      sharedByConvention: false,
    },
    {
      scope: "project",
      path: ".agents/mcp_config.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "inline-env" },
  nativeCapabilities: ["plugin", "skills", "rules"],
  skillLocations: [
    { scope: "project", path: ".agents/skills", sharedByConvention: true },
    { scope: "global", path: "~/.gemini/config/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Antigravity native plugin; public listing in preparation",
    url: "https://antigravity.google/docs/plugins",
    state: "PREPARATION",
  },
  transportFields: {
    // Antigravity uses `serverUrl` (not `url`) for HTTP-based MCP servers.
    "remote-http": { serverUrl: API_URL_PLACEHOLDER },
  },
  rulesFiles: ["GEMINI.md", "AGENTS.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://antigravity.google/docs/plugins",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://antigravity.google/docs/plugins",
    receipt: null,
  },
  gotchas: [
    "Antigravity uses `serverUrl`, not `url`, for HTTP servers — `url` is rejected.",
    "This registry surface targets Antigravity IDE/2.0. The CLI uses `~/.gemini/antigravity-cli/skills` globally, while its project skills use `.agents/skills`.",
    "Rules can live in `AGENTS.md`, `GEMINI.md` or `.agents/rules/*.md`; Antigravity 2.0 and the CLI also have distinct global rule directories.",
    "Antigravity 2.0 and the IDE discover native plugins from `.agents/plugins/` or `~/.gemini/config/plugins/`; the Antigravity CLI installs a local package with `agy plugin install`. LyraShield's plugin artifact is prepared for direct installation, but no public listing or client runtime receipt is confirmed.",
  ],
}

export const rooCode: AgentEntry = {
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

export const mimoCode: AgentEntry = {
  id: "mimo-code",
  displayName: "MiMo Code",
  docsSlug: "mimo-code",
  installStrategy: "config-file",
  format: "jsonc",
  rootKey: "mcp",
  locations: [
    { scope: "project", path: ".mimocode/mimocode.jsonc", sharedByConvention: false },
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
    checkedOn: "2026-10-02",
    url: "https://mimo.xiaomi.com/mimocode/config-overrides",
  },
  gotchas: [
    "Root key is `mcp`, not `mcpServers` — using `mcpServers` silently fails.",
    'Local uses `type: "local"` with `command` as an ARRAY (["npx","-y","<cmd>"]) and `environment` (not `command`+`args`+`env`), plus an `enabled` boolean.',
    'Remote uses `type: "remote"` with `url` + `headers` and `enabled`; OAuth is handled automatically.',
  ],
}

export const codebuff: AgentEntry = {
  id: "codebuff",
  displayName: "Codebuff",
  docsSlug: "codebuff",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    { scope: "project", path: ".agents/mcp.json", sharedByConvention: true },
    { scope: "global", path: "~/.agents/mcp.json", sharedByConvention: false },
  ],
  transports: ["stdio", "remote-http"],
  credential: { kind: "interpolated-env", syntax: "$LYRASHIELD_API_KEY" },
  transportFields: {
    "remote-http": { type: "http", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://www.codebuff.com/docs/tips/mcp-servers",
  },
  gotchas: [
    "Codebuff searches project `.agents/mcp.json`, then a parent `.agents/mcp.json`, then global `~/.agents/mcp.json`; later locations override earlier ones.",
    "Codebuff resolves `$VAR_NAME` references from the launching shell. Never put a literal key in a shared `.agents/mcp.json`.",
  ],
}

export const ohMyPi: AgentEntry = {
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
    url: "https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md",
  },
  gotchas: [
    "Project config is `.omp/mcp.json`; user config is `~/.omp/agent/mcp.json` (profile-aware at `~/.omp/profiles/<profile>/agent/mcp.json`). Oh-My-Pi also auto-discovers MCP servers from other tools like Claude Code and Cursor.",
    'Remote uses `type: "http"` for Streamable HTTP; stdio `type` may be omitted (default stdio `{command, args, env}`). Supports OAuth via `auth`/`oauth` fields, plus `/mcp add` and `omp plugin`.',
  ],
}

export const qwenCode: AgentEntry = {
  id: "qwen-code",
  displayName: "Qwen Code",
  surface: "cli",
  docsSlug: "qwen-code",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    { scope: "global", path: "~/.qwen/settings.json", sharedByConvention: false },
    { scope: "project", path: ".qwen/settings.json", sharedByConvention: true },
  ],
  transports: ["stdio", "remote-http"],
  preferredTransport: "remote-http",
  remoteAuth: "oauth",
  credential: { kind: "shell-env" },
  transportFields: {
    "remote-http": { httpUrl: API_URL_PLACEHOLDER },
  },
  nativeCapabilities: ["plugin", "skills", "commands", "rules"],
  distribution: {
    channel: "Qwen Code extension via Git, archive or npm",
    url: "https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction/",
    state: "PREPARATION",
  },
  manualInstructions:
    "The documented `settings.json` MCP path supports hosted OAuth discovery and is ready for direct setup. LyraShield's Qwen extension package is still in preparation; once available, install it with `qwen extensions install` from its Git, archive or npm source, then inspect its tools and skills with `/mcp` and `/skills`.",
  rulesFiles: ["QWEN.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/",
    receipt: null,
  },
  gotchas: [
    "Qwen Code's documented HTTP setting is `httpUrl`; remote OAuth is discovered and handled by the client. Restart the client or use `/mcp` after adding a server.",
    "Native Qwen extensions can bundle MCP servers, a context file, commands and skills. The extension loader uses `qwen-extension.json`; Agent Plugins v1 is a separate supported format and needs its own tested artifact.",
    "For cloud-hosted Qwen sessions, configure a reachable OAuth redirect URI; the default localhost redirect works only when the user's browser can reach that session.",
  ],
}
