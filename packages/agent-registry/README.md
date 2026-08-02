# @lyrashield/agent-registry

The single source of truth for LyraShield AI coding-agent integrations, installers, docs, and rules.

## Purpose

- Defines the supported agent catalog in `src/agents.ts` — 24 agents across config-file, guided-manual, and vendor-cli install strategies (e.g., Claude Code, Cursor, Windsurf, VS Code, Zed, OpenAI Codex, Gemini CLI, OpenCode, Kilo Code, Cline, JetBrains, Amp, Roo Code, MiMo Code, Codebuff, Oh-My-Pi, Copilot CLI, Goose, Aider, Devin CLI, Antigravity, PiCode, OpenClaw, Hermes).
- Describes each agent's config file locations, credential style, transport type, install strategy, source URL, and platform-specific gotchas.
- Renders agent configuration entries into JSON, JSONC, TOML, or YAML in `src/render.ts`.
- The `<apiUrl>` placeholder in `transportFields["remote-http"]` resolves to the Streamable-HTTP MCP endpoint (`<apiUrl>/api/mcp` after stripping any stale `/api/v1` suffix). The stdio `LYRASHIELD_API_URL` env block uses the base `apiUrl` directly.
- Exports schemas and types in `src/schema.ts` and `src/types.ts` used by the CLI installer and rule renderer.

## Main exports

- `getAgent(id)`, `listAgents()`, `agentsByStrategy(strategy)`, `AGENTS`
- `renderEntry(...)`, `renderConfig(...)`, `assertServerName(...)`
- Types: `AgentEntry`, `ConfigLocation`, `CredentialStyle`, `InstallStrategy`, `Transport`

## See also

- `packages/cli/README.md`
- `packages/cli/src/commands/install.ts`
- `packages/agent-rules/README.md`
