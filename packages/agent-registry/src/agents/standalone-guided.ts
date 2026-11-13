import type { AgentEntry } from "../types"
import { API_URL_PLACEHOLDER, MCP_PACKAGE_SPEC, LAST_AGENT_REGISTRY_CHECK_DATE } from "./shared"

export const openclaw: AgentEntry = {
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

export const goose: AgentEntry = {
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

export const aider: AgentEntry = {
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

export const factoryDroid: AgentEntry = {
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
    "Droid's plugin system bundles skills, slash commands, hooks, MCP servers and other components. User and project marketplace scopes are separate.",
    "Remote HTTP MCP uses OAuth Dynamic Client Registration by default and stores tokens in the system keyring or a fallback file. Keep secrets out of project-level `.factory/mcp.json`; the hosted LyraShield endpoint is read-only unless an authorized browser-confirmed delegation is recorded.",
    "Skills can also be installed in `.factory/skills` or `~/.factory/skills`; avoid committing credentials in project settings.",
  ],
}

export const continueDev: AgentEntry = {
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
    "Create a Continue MCP block at .continue/mcpServers/lyrashield.yaml with required name, version and schema v1 metadata. Add a stdio server with command npx and args -y plus " +
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
    "Continue's project MCP blocks are YAML files under `.continue/mcpServers/`; the required wrapper fields are `name`, `version` and `schema: v1`, with MCP servers represented as a list.",
    "Continue documents Streamable HTTP but its MCP guide does not document OAuth. This registry entry uses local stdio; do not put a hosted API key in a shared project file.",
    "Rules are separate files under `.continue/rules`. This entry covers the IDE configuration contract; the Continue CLI surface requires separate acceptance.",
  ],
}

export const mistralVibe: AgentEntry = {
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

export const lovable: AgentEntry = {
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
    "Import LyraShield skills from a GitHub skill URL or ZIP in Workspace Settings → Skills. Add the hosted MCP server from Workspace Settings → Connectors → Add custom MCP, enter the LyraShield endpoint and complete the OAuth flow. Team and Enterprise custom connectors may need an Owner to add the connector first.",
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

export const v0: AgentEntry = {
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
    "In the v0 prompt form, open + → MCP, choose a custom MCP server, enter the LyraShield endpoint and select OAuth. Review tool approval and permission settings before using tools. This direct MCP setup does not imply a Vercel Marketplace listing.",
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
    "v0 supports custom remote MCP servers with OAuth, bearer tokens or custom headers. No local project config file is documented.",
    "Vercel Marketplace integrations are a separate route from v0's bring-your-own MCP server configuration; listing eligibility and approval are not established here.",
  ],
}

export const replitAgent: AgentEntry = {
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
