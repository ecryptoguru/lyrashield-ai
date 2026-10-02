import type { AgentEntry, RegistryAgentEntry } from "./types"
import { API_URL_PLACEHOLDER } from "./render"
import { CLI_PACKAGE_SPEC, MCP_PACKAGE_SPEC } from "./versions"

const LAST_AGENT_REGISTRY_CHECK_DATE = "2026-09-09"

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

const devinDesktop: AgentEntry = {
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

const vscode: AgentEntry = {
  id: "vscode",
  displayName: "GitHub Copilot in VS Code (MCP config)",
  productFamily: { id: "github-copilot", name: "GitHub Copilot" },
  surface: "ide",
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
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { url: API_URL_PLACEHOLDER },
  },
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://developers.openai.com/codex/mcp",
  },
  gotchas: [
    "Explicit values belong in `[mcp_servers.lyrashield.env]`. Codex reserves `env_vars` for an array of environment-variable names inherited from the parent process.",
  ],
}

const cline: AgentEntry = {
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

const opencode: AgentEntry = {
  id: "opencode",
  displayName: "OpenCode",
  productFamily: { id: "opencode", name: "OpenCode" },
  surface: "cli",
  nativeCapabilities: ["skills"],
  skillLocations: [
    { scope: "project", path: ".opencode/skills", sharedByConvention: true },
    { scope: "global", path: "~/.config/opencode/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "OpenCode native skill discovery",
    url: "https://opencode.ai/docs/skills",
    state: "DIRECT",
  },
  docsSlug: "opencode",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcp",
  locations: [
    {
      scope: "global",
      path: "~/.config/opencode/opencode.json",
      sharedByConvention: false,
    },
    {
      scope: "project",
      path: "opencode.json",
      sharedByConvention: true,
    },
  ],
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
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
    url: "https://opencode.ai/docs/mcp-servers/",
  },
  gotchas: [
    "OpenCode's global config is `~/.config/opencode/opencode.json`; project `opencode.json` overrides it.",
    "OpenCode uses single-brace `{env:VAR}` syntax, not `${VAR}`; wrong syntax passes the literal string through.",
    'OpenCode local entries use `type: "local"`, a command array and `environment`; remote entries use `type: "remote"`.',
    "OpenCode stores servers under the top-level `mcp` object and uses `enabled: false` to disable an entry.",
  ],
}

const opencodeV2: AgentEntry = {
  id: "opencode-v2",
  displayName: "OpenCode V2",
  productFamily: { id: "opencode", name: "OpenCode" },
  surface: "cli",
  versionConstraints: {
    minimum: "2",
    note: "V2 places MCP servers under mcp.servers; the stable V1 renderer uses the former mcp root map.",
  },
  docsSlug: "opencode-v2",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  preferredTransport: "remote-http",
  remoteAuth: "oauth",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills"],
  skillLocations: [
    { scope: "project", path: ".opencode/skills", sharedByConvention: true },
    { scope: "global", path: "~/.config/opencode/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "OpenCode V2 skills and MCP configuration",
    url: "https://opencode.ai/v2/docs/mcp-servers",
    state: "DIRECT",
  },
  manualInstructions:
    "For V2, add LyraShield with opencode mcp add lyrashield --url https://app.lyrashieldai.com/api/mcp and complete OAuth with opencode mcp auth lyrashield. If editing JSON manually, put the entry under mcp.servers.lyrashield; V2 uses type remote for HTTP and type local for stdio. The native skill locations remain .opencode/skills and ~/.config/opencode/skills.",
  rulesFiles: ["AGENTS.md"],
  source: { checkedOn: "2026-10-01", url: "https://opencode.ai/v2/docs/mcp-servers" },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://opencode.ai/v2/docs/mcp-servers",
    receipt: null,
  },
  gotchas: [
    "OpenCode V2 uses mcp.servers and a nested per-server object; the stable OpenCode entry represents V1 mcp root and is not interchangeable.",
    "V2 MCP remote connections use OAuth by default and can be authorized through opencode mcp auth lyrashield; do not add a bearer header when using OAuth.",
    "V2 skill discovery still uses .opencode/skills and ~/.config/opencode/skills and is compatible with the portable Agent Skills layout.",
  ],
}

const kiloCode: AgentEntry = {
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

const geminiCli: AgentEntry = {
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

const jetbrains: AgentEntry = {
  id: "jetbrains",
  aliases: ["jetbrains-ai-assistant"],
  displayName: "JetBrains AI Assistant",
  productFamily: { id: "jetbrains", name: "JetBrains" },
  surface: "ide",
  docsSlug: "jetbrains",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  credential: { kind: "ui-fields" },
  distribution: {
    channel: "JetBrains AI Assistant MCP settings and agent skills",
    url: "https://www.jetbrains.com/help/ai-assistant/agents.html",
    state: "DIRECT",
  },
  manualInstructions:
    "Configure the MCP server in Settings → Tools → AI Assistant → Model Context Protocol (MCP). The same MCP settings can be passed to supported Claude Agent and Codex integrations; use their separate registry entries for agent-specific skills and activation steps.",
  rulesFiles: ["AGENTS.md"],
  source: { checkedOn: "2026-10-01", url: "https://www.jetbrains.com/help/ai-assistant/mcp.html" },
  gotchas: [
    "JetBrains AI Assistant has no stable MCP file path; use its Settings UI and review the displayed connection status and tool list.",
    "MCP can be configured for AI Assistant directly. Hosted Claude Agent and Codex have separate entries because their MCP forwarding and skill paths differ.",
    "Organization-managed IDE Services/Central policies can preconfigure servers or prevent users from adding them.",
  ],
}

const junieIde: AgentEntry = {
  id: "junie",
  displayName: "Junie IDE",
  productFamily: { id: "jetbrains", name: "JetBrains" },
  surface: "ide",
  docsSlug: "junie",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    { scope: "project", path: ".junie/mcp/mcp.json", sharedByConvention: true },
    { scope: "global", path: "~/.junie/mcp/mcp.json", sharedByConvention: false },
  ],
  transports: ["stdio"],
  preferredTransport: "stdio",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills", "commands", "rules", "plugin", "hooks"],
  skillLocations: [
    { scope: "project", path: ".junie/skills", sharedByConvention: true },
    { scope: "global", path: "~/.junie/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Junie extensions and native skills",
    url: "https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html",
    state: "PREPARATION",
  },
  manualInstructions:
    "For Junie in JetBrains IDEs, add the stdio server through Settings → Tools → Junie → MCP Settings, or edit .junie/mcp/mcp.json at project scope and ~/.junie/mcp/mcp.json at user scope. The IDE docs do not establish the remote OAuth flow available in Junie CLI, so use local stdio here. Add skills under .junie/skills or ~/.junie/skills.",
  rulesFiles: [".junie/rules/lyrashield.md", "AGENTS.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://junie.jetbrains.com/docs/junie-plugin-mcp-settings.html",
    receipt: null,
  },
  gotchas: [
    "Junie IDE MCP files use the mcpServers JSON object. Keep credentials out of shared project files and provide local environment values outside committed configuration.",
    "Junie IDE and Junie CLI have separate entries because only the current CLI guide explicitly documents remote OAuth authorization.",
    "Project settings and skills load only in a trusted project; inspect the IDE connection status and tool list after activation.",
  ],
}

const junieCli: AgentEntry = {
  id: "junie-cli",
  displayName: "Junie CLI",
  productFamily: { id: "jetbrains", name: "JetBrains" },
  surface: "cli",
  docsSlug: "junie-cli",
  installStrategy: "config-file",
  format: "json",
  rootKey: "mcpServers",
  locations: [
    { scope: "project", path: ".junie/mcp/mcp.json", sharedByConvention: true },
    { scope: "global", path: "~/.junie/mcp/mcp.json", sharedByConvention: false },
  ],
  transports: ["stdio", "remote-http"],
  preferredTransport: "remote-http",
  remoteAuth: "oauth",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills", "commands", "rules", "plugin", "hooks"],
  skillLocations: [
    { scope: "project", path: ".junie/skills", sharedByConvention: true },
    { scope: "global", path: "~/.junie/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Junie extensions marketplace and native skills",
    url: "https://junie.jetbrains.com/docs/junie-cli-extensions.html",
    state: "PREPARATION",
  },
  manualInstructions:
    "For Junie CLI, use /mcp to add the remote LyraShield MCP server and complete browser OAuth authorization. The same server can be configured in .junie/mcp/mcp.json or ~/.junie/mcp/mcp.json. Skills are discovered under .junie/skills and ~/.junie/skills; use /skills to verify discovery.",
  rulesFiles: [".junie/rules/lyrashield.md", "AGENTS.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html",
    receipt: null,
  },
  gotchas: [
    "Junie CLI remote OAuth is available through /mcp and browser authorization. Use that flow instead of a static hosted API key.",
    "Project MCP and skill configuration is loaded only after project trust. Untrusted projects use temporary isolated project configuration.",
    "Junie extensions package skills, MCP configurations, commands, guidelines, and hooks; the LyraShield extension listing remains PREPARATION.",
  ],
}

const jetbrainsClaudeAgent: AgentEntry = {
  id: "jetbrains-claude-agent",
  displayName: "JetBrains Claude Agent",
  productFamily: { id: "jetbrains", name: "JetBrains" },
  surface: "ide",
  docsSlug: "jetbrains-claude-agent",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  preferredTransport: "stdio",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills"],
  skillLocations: [{ scope: "project", path: ".claude/skills", sharedByConvention: true }],
  distribution: {
    channel: "JetBrains AI Assistant hosted Claude Agent",
    url: "https://www.jetbrains.com/help/ai-assistant/agent-skills.html",
    state: "DIRECT",
  },
  manualInstructions:
    "Configure the local stdio MCP server in JetBrains AI Assistant → Settings → Tools → Model Context Protocol, then select Claude Agent in AI Assistant. Install project skills under .claude/skills or import them from Claude global skills. Provider login and MCP-server authentication are separate steps.",
  rulesFiles: ["CLAUDE.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://www.jetbrains.com/help/ai-assistant/agents.html",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://www.jetbrains.com/help/ai-assistant/agents.html",
    receipt: null,
  },
  gotchas: [
    "The embedded Claude Agent supports Agent Skills and uses Claude-specific project instructions in CLAUDE.md.",
    "MCP server configuration is shared through AI Assistant settings; the embedded agent provider login does not authenticate the LyraShield MCP connection.",
  ],
}

const jetbrainsCodexAgent: AgentEntry = {
  id: "jetbrains-codex-agent",
  displayName: "JetBrains Codex Agent",
  productFamily: { id: "jetbrains", name: "JetBrains" },
  surface: "ide",
  docsSlug: "jetbrains-codex-agent",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  preferredTransport: "stdio",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills"],
  skillLocations: [{ scope: "project", path: ".codex/skills", sharedByConvention: true }],
  distribution: {
    channel: "JetBrains AI Assistant hosted Codex agent",
    url: "https://www.jetbrains.com/help/ai-assistant/codex-agent.html",
    state: "DIRECT",
  },
  manualInstructions:
    "Configure the local stdio MCP server in JetBrains AI Assistant → Settings → Tools → Model Context Protocol, then enable Pass custom MCP servers in the Agents settings before selecting Codex. Install project skills under .codex/skills or import them through AI Assistant. Provider login and MCP-server authentication are separate steps.",
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://www.jetbrains.com/help/ai-assistant/codex-agent.html",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://www.jetbrains.com/help/ai-assistant/codex-agent.html",
    receipt: null,
  },
  gotchas: [
    "Codex skills and AGENTS.md are supported in the embedded agent. MCP servers configured in AI Assistant are not exposed until Pass custom MCP servers is enabled.",
    "The embedded Codex provider login is separate from the LyraShield MCP connection; use local stdio credentials for this guided setup.",
  ],
}

const amp: AgentEntry = {
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

const picode: AgentEntry = {
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

const openclaw: AgentEntry = {
  id: "openclaw",
  displayName: "OpenClaw",
  docsSlug: "openclaw",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "inline-env" },
  transportFields: {
    "remote-http": { transport: "streamable-http", url: API_URL_PLACEHOLDER },
  },
  rulesFiles: ["OpenClaw skill.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.openclaw.ai/cli/mcp",
  },
  gotchas: [
    "OpenClaw manages client-side servers with `openclaw mcp add`, `set` and `configure` or in its Control UI at /settings/mcp. Do not use mcporter configuration for OpenClaw-managed servers.",
    'Local entries use `command` and repeated `--arg` flags. For Streamable HTTP, use `transport: "streamable-http"`; then run `openclaw mcp doctor --probe` for a live tool-list check.',
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

const antigravity: AgentEntry = {
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
    "Rules can live in `AGENTS.md`, `GEMINI.md`, or `.agents/rules/*.md`; Antigravity 2.0 and the CLI also have distinct global rule directories.",
    "Antigravity 2.0 and the IDE discover native plugins from `.agents/plugins/` or `~/.gemini/config/plugins/`; the Antigravity CLI installs a local package with `agy plugin install`. LyraShield's plugin artifact is prepared for direct installation, but no public listing or client runtime receipt is confirmed.",
  ],
}

const copilotCli: AgentEntry = {
  id: "copilot-cli",
  displayName: "GitHub Copilot CLI",
  productFamily: { id: "github-copilot", name: "GitHub Copilot" },
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

const githubCopilotCloudAgent: AgentEntry = {
  id: "github-copilot-cloud-agent",
  displayName: "GitHub Copilot Cloud Agent",
  productFamily: { id: "github-copilot", name: "GitHub Copilot" },
  surface: "cloud",
  docsSlug: "github-copilot-cloud-agent",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["remote-http"],
  preferredTransport: "remote-http",
  remoteAuth: "api-key",
  credential: { kind: "ui-fields" },
  nativeCapabilities: ["plugin", "skills"],
  skillLocations: [{ scope: "project", path: ".github/skills", sharedByConvention: true }],
  skillInstallState: "withheld",
  distribution: {
    channel: "GitHub Copilot read-only MCP; surface-safe workflow skills pending validation",
    url: "https://docs.github.com/en/copilot/concepts/agents/cloud-agent/mcp-and-cloud-agent",
    state: "PREPARATION",
  },
  manualInstructions:
    'Skill installation is withheld because the published workflow set has not yet been reduced and validated for this read-only surface. Do not copy skills from the mutable preparation branch into `.github/skills/`. The intended read-only set is `get-started`, `review-changes`, and `launch-readiness`; use direct MCP tools meanwhile. Do not enable the full marketplace plugin: it includes workflows and an OAuth MCP descriptor that this surface cannot use. Skill discovery is separate from MCP authentication. Allow only the read-only tools `lyrashield_check_diff`, `lyrashield_get_launch_readiness`, `lyrashield_list_targets`, and `lyrashield_list_workspaces`. Configure the remote server separately in GitHub repository Settings → Code, planning, and automation → Copilot → MCP servers with `type: "http"`, `url: "https://app.lyrashieldai.com/api/mcp", and `headers.Authorization: "Bearer $COPILOT_MCP_LYRASHIELD_API_KEY"`. Create a read-only LyraShield workspace API key and save it as an Agents secret named `COPILOT_MCP_LYRASHIELD_API_KEY` under Settings → Security → Secrets and variables → Agents. Omit `*` because GitHub lets Cloud Agent use configured tools autonomously. Do not install `scan-project`, `fix-and-retest`, or the backward-compatible `lyrashield` skill on this read-only surface; requested recorded scans, fixes, and retests require an OAuth-capable client. The optional recorded scan action in `review-changes` is not allowlisted. Copilot Cloud Agent does not support remote OAuth, and hosted mutations still return `connect_required`. This documentation-only entry has no authenticated Cloud Agent runtime receipt.',
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.github.com/en/copilot/concepts/agents/cloud-agent/mcp-and-cloud-agent",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.github.com/en/copilot/concepts/agents/cloud-agent/mcp-and-cloud-agent",
    receipt: null,
  },
  gotchas: [
    "Cloud Agent and Copilot code review share repository MCP settings; configured MCP tools are used autonomously, so allowlist read-only tools and review the target repository before enabling them.",
    "The planned read-only skill set, withheld until a surface-safe bundle is validated, is `get-started`, `review-changes`, and `launch-readiness`; the tool allowlist includes only read-only calls. Recorded scans, fixes and retests require an OAuth-capable client.",
    "GitHub documents `$COPILOT_MCP_...` substitutions for remote headers and requires those values to come from Agents secrets or variables. The key authenticates read-only calls; it cannot grant hosted mutations, which return `connect_required` without a connected OAuth delegation.",
    "Remote MCP OAuth is not supported by Copilot Cloud Agent. Portable plugin and skills discovery is separate from service authentication; a plugin install or skill discovery is not evidence that the LyraShield MCP server connected.",
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
    url: "https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/using-extensions.md",
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
  transports: [],
  integrationKind: "standalone-cli",
  credential: { kind: "shell-env" },
  manualInstructions:
    "Aider does not document native MCP client support. Run `lyrashield check-diff` or `lyrashield gate --verdict` as a separate repository check; do not add an `mcp-servers` key to Aider configuration.",
  rulesFiles: [],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://aider.chat/docs/config/aider_conf.html",
  },
  gotchas: [
    "Aider's official configuration reference has no `mcp-servers` setting or `--mcp-servers` CLI option.",
    "Use LyraShield's standalone CLI and CI paths until Aider ships an official MCP client contract.",
  ],
}

const devinCli: AgentEntry = {
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
  format: "jsonc",
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
    url: "https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md",
  },
  gotchas: [
    "Project config is `.omp/mcp.json`; user config is `~/.omp/agent/mcp.json` (profile-aware at `~/.omp/profiles/<profile>/agent/mcp.json`). Oh-My-Pi also auto-discovers MCP servers from other tools like Claude Code and Cursor.",
    'Remote uses `type: "http"` for Streamable HTTP; stdio `type` may be omitted (default stdio `{command, args, env}`). Supports OAuth via `auth`/`oauth` fields, plus `/mcp add` and `omp plugin`.',
  ],
}

const auggie: AgentEntry = {
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
    "Auggie plugins support skills, commands, rules, hooks, and MCP, and also accept Claude Code plugin layouts. LyraShield's Auggie marketplace listing remains PREPARATION.",
  ],
}

const augmentVSCode: AgentEntry = {
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

const augmentJetBrains: AgentEntry = {
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

const factoryDroid: AgentEntry = {
  id: "factory-droid",
  displayName: "Factory Droid",
  surface: "cli",
  docsSlug: "factory-droid",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  preferredTransport: "remote-http",
  remoteAuth: "oauth",
  credential: { kind: "ui-fields" },
  nativeCapabilities: ["plugin", "skills", "commands", "hooks"],
  skillLocations: [
    { scope: "project", path: ".factory/skills", sharedByConvention: true },
    { scope: "global", path: "~/.factory/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Factory Droid plugin marketplace",
    url: "https://docs.factory.com/harness/plugins",
    state: "PREPARATION",
  },
  manualInstructions:
    "For the hosted endpoint, run `droid mcp add lyrashield https://app.lyrashieldai.com/api/mcp --type http` or add the same remote server in `/mcp`. Factory Droid uses zero-configuration OAuth Dynamic Client Registration by default and stores tokens in the system keyring; do not add `--no-oauth` or copy a bearer token into project config. Complete browser consent, select one LyraShield workspace, then verify a read-only call. Local stdio with the authenticated LyraShield CLI credential store remains an alternative. The LyraShield Droid plugin marketplace package is still in preparation, and this entry has no authenticated runtime receipt.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.factory.com/harness/mcp",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.factory.com/harness/mcp",
    receipt: null,
  },
  gotchas: [
    "Droid's plugin system bundles skills, slash commands, hooks, MCP servers, and other components. User and project marketplace scopes are separate.",
    "Remote HTTP MCP uses OAuth Dynamic Client Registration by default and stores tokens in the system keyring or a fallback file. Keep secrets out of project-level `.factory/mcp.json`; the hosted LyraShield endpoint is read-only unless an authorized browser-confirmed delegation is recorded.",
    "Skills can also be installed in `.factory/skills` or `~/.factory/skills`; avoid committing credentials in project settings.",
  ],
}

const qoder: AgentEntry = {
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
    "Qoder IDE supports imported plugins bundling skills, MCP, commands, rules, and hooks. LyraShield's client package is still in preparation.",
    "Review MCP permissions and connector authentication in the UI before use; this IDE entry does not inherit Qoder CLI's OAuth flow or configuration paths.",
  ],
}

const qoderCli: AgentEntry = {
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
    "Native CLI skills live in `.qoder/skills` and `~/.qoder/skills`. Qoder plugins can bundle MCP, commands, skills, hooks, and workflows; the LyraShield plugin listing remains PREPARATION.",
  ],
}

const qwenCode: AgentEntry = {
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
    channel: "Qwen Code extension via Git, archive, or npm",
    url: "https://qwenlm.github.io/qwen-code-docs/en/users/extension/introduction/",
    state: "PREPARATION",
  },
  manualInstructions:
    "The documented `settings.json` MCP path supports hosted OAuth discovery and is ready for direct setup. LyraShield's Qwen extension package is still in preparation; once available, install it with `qwen extensions install` from its Git, archive, or npm source, then inspect its tools and skills with `/mcp` and `/skills`.",
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
    "Native Qwen extensions can bundle MCP servers, a context file, commands, and skills. The extension loader uses `qwen-extension.json`; Agent Plugins v1 is a separate supported format and needs its own tested artifact.",
    "For cloud-hosted Qwen sessions, configure a reachable OAuth redirect URI; the default localhost redirect works only when the user's browser can reach that session.",
  ],
}

const continueDev: AgentEntry = {
  id: "continue",
  displayName: "Continue",
  surface: "ide",
  docsSlug: "continue",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio"],
  preferredTransport: "stdio",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["rules"],
  distribution: {
    channel: "Continue Hub and project-local MCP/rules blocks",
    url: "https://docs.continue.dev/customize/deep-dives/mcp",
    state: "DIRECT",
  },
  manualInstructions:
    "Create a Continue MCP block at .continue/mcpServers/lyrashield.yaml with required name, version, and schema v1 metadata. Add a stdio server with command npx and args -y plus " +
    MCP_PACKAGE_SPEC +
    ", and environment values for the LyraShield API URL and a user-provided LYRASHIELD_API_KEY. Keep secrets in Continue local secrets or environment support; its current MCP guide does not document remote OAuth. Project rules can be placed under .continue/rules.",
  rulesFiles: [".continue/rules/lyrashield.md"],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.continue.dev/customize/deep-dives/mcp",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.continue.dev/customize/deep-dives/mcp",
    receipt: null,
  },
  gotchas: [
    "Continue's project MCP blocks are YAML files under `.continue/mcpServers/`; the required wrapper fields are `name`, `version`, and `schema: v1`, with MCP servers represented as a list.",
    "Continue documents Streamable HTTP but its MCP guide does not document OAuth. This registry entry uses local stdio; do not put a hosted API key in a shared project file.",
    "Rules are separate files under `.continue/rules`. This entry covers the IDE configuration contract; the Continue CLI surface requires separate acceptance.",
  ],
}

const mistralVibe: AgentEntry = {
  id: "mistral-vibe",
  displayName: "Mistral Vibe Code CLI",
  surface: "cli",
  docsSlug: "mistral-vibe",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["stdio", "remote-http"],
  preferredTransport: "stdio",
  remoteAuth: "api-key",
  credential: { kind: "shell-env" },
  nativeCapabilities: ["skills", "commands"],
  skillLocations: [
    { scope: "project", path: ".vibe/skills", sharedByConvention: true },
    { scope: "global", path: "~/.vibe/skills", sharedByConvention: false },
  ],
  distribution: {
    channel: "Direct Agent Skills and Vibe MCP configuration",
    url: "https://docs.mistral.ai/vibe/code/cli/skills",
    state: "DIRECT",
  },
  manualInstructions:
    "Place shared skills in `.vibe/skills` in a trusted project or `~/.vibe/skills` for the user. Vibe MCP servers use `[[mcp_servers]]` entries in `./.vibe/config.toml` or `~/.vibe/config.toml`; the registry renderer does not write this array-table format, so use the official `vibe mcp add` flow or edit the file carefully. Vibe MCP currently does not support OAuth; a static API key does not substitute for hosted delegation.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.mistral.ai/vibe/code/cli/mcp-servers",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.mistral.ai/vibe/code/cli/mcp-servers",
    receipt: null,
  },
  gotchas: [
    "The CLI and VS Code extension share configuration, but this registry entry documents the CLI surface. Vibe Code Web is a separate hosted surface.",
    "Vibe skills can expose slash commands with `user-invocable: true`. Project-level skills load only after the workspace is trusted.",
    "The official MCP reference says OAuth is not yet supported; static credentials such as an environment-backed API key are required for remote MCP.",
  ],
}

const lovable: AgentEntry = {
  id: "lovable",
  displayName: "Lovable",
  surface: "web",
  docsSlug: "lovable",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "ui-fields" },
  nativeCapabilities: ["skills"],
  distribution: {
    channel: "GitHub/ZIP Agent Skills and custom MCP connectors",
    url: "https://docs.lovable.dev/features/skills",
    state: "DIRECT",
  },
  manualInstructions:
    "Import LyraShield skills from a GitHub skill URL or ZIP in Workspace Settings → Skills. Add the hosted MCP server from Workspace Settings → Connectors → Add custom MCP, enter the LyraShield endpoint, and complete the OAuth flow. Team and Enterprise custom connectors may need an Owner to add the connector first.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.lovable.dev/integrations/custom-mcp",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.lovable.dev/integrations/custom-mcp",
    receipt: null,
  },
  gotchas: [
    "Lovable imports skills as Agent Skills from a GitHub URL or ZIP; it does not expose a project-local skill directory for registry-managed writes.",
    "Custom MCP connectors are workspace chat/build-time tools. They are distinct from integrations embedded in an app generated with Lovable.",
    "The connector setup defaults to OAuth and supports bearer/API keys as an alternative. Use the OAuth route for hosted delegated workflows.",
  ],
}

const v0: AgentEntry = {
  id: "v0",
  displayName: "v0",
  surface: "web",
  docsSlug: "v0",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "ui-fields" },
  distribution: {
    channel: "Bring-your-own remote MCP server",
    url: "https://v0.app/docs/MCP",
    state: "DIRECT",
  },
  manualInstructions:
    "In the v0 prompt form, open + → MCP, choose a custom MCP server, enter the LyraShield endpoint, and select OAuth. Review tool approval and permission settings before using tools. This direct MCP setup does not imply a Vercel Marketplace listing.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://v0.app/docs/MCP",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://v0.app/docs/MCP",
    receipt: null,
  },
  gotchas: [
    "v0 supports custom remote MCP servers with OAuth, bearer tokens, or custom headers. No local project config file is documented.",
    "Vercel Marketplace integrations are a separate route from v0's bring-your-own MCP server configuration; listing eligibility and approval are not established here.",
  ],
}

const replitAgent: AgentEntry = {
  id: "replit-agent",
  displayName: "Replit Agent",
  surface: "cloud",
  docsSlug: "replit-agent",
  installStrategy: "guided-manual",
  format: null,
  rootKey: null,
  locations: [],
  transports: ["remote-http"],
  remoteAuth: "oauth",
  credential: { kind: "ui-fields" },
  nativeCapabilities: ["skills"],
  skillLocations: [{ scope: "project", path: ".agents/skills", sharedByConvention: true }],
  distribution: {
    channel: "Custom Replit MCP integration and project Agent Skills",
    url: "https://docs.replit.com/features/mcp/overview",
    state: "DIRECT",
  },
  manualInstructions:
    "Add LyraShield as a custom MCP integration in Replit Agent using the hosted Streamable HTTP endpoint and OAuth. Import shared skills under the project `.agents/skills` directory or through Workspace Settings for workspace-level availability. Replit's custom install link can carry the endpoint metadata, but never embed a secret in a shared link.",
  rulesFiles: [],
  source: {
    checkedOn: "2026-10-01",
    url: "https://docs.replit.com/features/mcp/overview",
  },
  supportTier: "COMPATIBLE",
  verification: {
    evidence: "DOCUMENTATION",
    checkedOn: "2026-10-01",
    clientVersion: null,
    platforms: [],
    reference: "https://docs.replit.com/features/mcp/overview",
    receipt: null,
  },
  gotchas: [
    "Replit supports OAuth dynamic client registration when the MCP server supports it and offers static custom headers as a fallback. LyraShield has a dynamic registration endpoint; client runtime acceptance is still pending.",
    "Project skills use `/.agents/skills`; workspace-level skills are managed in Workspace Settings. No plugin package format is claimed for Replit Agent.",
    "Replit scans MCP tool definitions and planned executions; its cloud workspace and permissions remain distinct from local CLI credentials.",
  ],
}

const claudeDesktop: AgentEntry = {
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

const claudeWeb: AgentEntry = {
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

const claudeCodePlugin: AgentEntry = {
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

const vscodePlugin: AgentEntry = {
  id: "vscode-agent-plugin",
  displayName: "GitHub Copilot in VS Code (Agent Plugin)",
  productFamily: { id: "github-copilot", name: "GitHub Copilot" },
  surface: "ide",
  docsSlug: "vscode-agent-plugin",
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
  nativeCapabilities: ["plugin", "skills", "commands", "rules", "hooks"],
  manualInstructions:
    "VS Code Agent Plugin setup is manual: the LyraShield CLI returns MANUAL_REQUIRED and does not install or register this plugin. The package is published, but a public listing and authenticated client runtime acceptance remain pending. Do not use the mutable marketplace preparation branch. Until those checks pass, manually merge the VS Code MCP fallback into `.vscode/mcp.json`, preserving existing servers and settings. Plugin installation, client discovery, OAuth authentication and a read-only call are separate checks.",
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://code.visualstudio.com/docs/agent-customization/agent-plugins",
  },
  gotchas: [
    "VS Code reads the portable root `plugin.json`; there is no VS Code-specific shim directory. Our manifest declares the Agent Plugins 1.0 `$schema`, so VS Code classifies it as Agent Plugins 1.0 and takes MCP servers from the root `mcp.json`.",
    "Auto-registration is NOT wired yet, so this path is a staging copy rather than a discovery path. VS Code only auto-discovers plugins under `~/.copilot/installed-plugins/`; everything else arrives via a configured marketplace, Install-from-Source or an explicit entry in the `chat.pluginLocations` setting.",
    "If plugin installation is unavailable, use the documented `.vscode/mcp.json` MCP configuration fallback. Agent plugins additionally require the `chat.plugins.enabled` setting. Configuration does not establish authenticated client acceptance.",
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
  manualInstructions: `The Agent Plugin package is published, but the OpenAI Codex public listing and authenticated runtime acceptance remain pending. Do not install from the mutable marketplace preparation branch. Use the current direct-MCP fallback: merge the [mcp_servers.lyrashield] stdio table into ~/.codex/config.toml with command npx and args ["-y", "${MCP_PACKAGE_SPEC}"], preserving existing entries. Authenticate separately with npx -y ${CLI_PACKAGE_SPEC} login --oauth in the same OS account, restart Codex, confirm server/tool discovery, then call lyrashield_list_workspaces. See /docs/integrations/openai-codex.`,
  rulesFiles: ["AGENTS.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://developers.openai.com/codex/plugins/build",
  },
  gotchas: [
    "The marketplace preparation branch is not a released install artifact. Use the pinned stdio MCP fallback until a reviewed immutable plugin release exists.",
    "Local CLI OAuth authentication, Codex server discovery and a successful authenticated read are separate checks.",
  ],
}

const githubCopilotPlugin: AgentEntry = {
  id: "github-copilot-agent-plugin",
  displayName: "GitHub Copilot (Agent Plugin)",
  productFamily: { id: "github-copilot", name: "GitHub Copilot" },
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
  manualInstructions: `The Agent Plugin package is published, but the GitHub Copilot public listing and authenticated runtime acceptance remain pending. Do not install from the mutable marketplace preparation branch. Use the current direct-MCP fallback: merge mcpServers.lyrashield into ~/.copilot/mcp-config.json with type "local", command npx and args ["-y", "${MCP_PACKAGE_SPEC}"], preserving other servers. Authenticate separately with npx -y ${CLI_PACKAGE_SPEC} login --oauth in the same OS account, restart Copilot CLI, use /mcp show lyrashield to confirm discovery, then call lyrashield_list_workspaces. See /docs/integrations/github-copilot.`,
  rulesFiles: [".github/copilot-instructions.md"],
  source: {
    checkedOn: LAST_AGENT_REGISTRY_CHECK_DATE,
    url: "https://docs.github.com/en/copilot/concepts/agents/about-plugins",
  },
  gotchas: [
    "GitHub Copilot CLI scans each plugin directory for a `plugin.json` manifest at the root.",
    "For the current stdio fallback, local CLI OAuth, client discovery and an authenticated read are separate checks.",
  ],
}

const kiroPlugin: AgentEntry = {
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

const EXPERIMENTAL_AGENT_IDS = new Set([
  "aider",
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
  devinDesktop,
  vscode,
  openaiCodex,
  cline,
  opencode,
  opencodeV2,
  kiloCode,
  zed,
  geminiCli,
  jetbrains,
  junieIde,
  junieCli,
  jetbrainsClaudeAgent,
  jetbrainsCodexAgent,
  amp,
  picode,
  openclaw,
  hermes,
  antigravity,
  copilotCli,
  githubCopilotCloudAgent,
  goose,
  aider,
  devinCli,
  rooCode,
  mimoCode,
  codebuff,
  ohMyPi,
  auggie,
  augmentVSCode,
  augmentJetBrains,
  factoryDroid,
  qoder,
  qoderCli,
  qwenCode,
  continueDev,
  mistralVibe,
  lovable,
  v0,
  replitAgent,
  claudeDesktop,
  claudeWeb,
  claudeCodePlugin,
  cursorPlugin,
  vscodePlugin,
  openaiCodexPlugin,
  githubCopilotPlugin,
  kiroPlugin,
].map((agent) => {
  const defaultTier = EXPERIMENTAL_AGENT_IDS.has(agent.id) ? "EXPERIMENTAL" : "COMPATIBLE"
  const evidence =
    agent.verification?.evidence ??
    (PACKAGE_CONFORMANCE_AGENT_IDS.has(agent.id) ? "PACKAGE_CONFORMANCE" : "DOCUMENTATION")

  return {
    ...agent,
    integrationKind: agent.integrationKind ?? "mcp",
    preferredTransport:
      agent.integrationKind === "standalone-cli"
        ? null
        : (agent.preferredTransport ?? agent.transports[0]!),
    remoteAuth:
      agent.installStrategy === "agent-plugin" && agent.transports.includes("remote-http")
        ? (agent.remoteAuth ?? "oauth")
        : agent.remoteAuth,
    supportTier: agent.supportTier ?? defaultTier,
    verification: agent.verification ?? {
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
