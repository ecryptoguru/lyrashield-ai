# @lyrashield/agent-registry

The single source of truth for LyraShield AI coding-agent integrations, installers, docs, and rules.

## Purpose

- Defines the supported agent catalog in `src/agents.ts` — **30 install entries resolving to 26 preferred client surfaces** across config-file, guided-manual, vendor-cli, and `agent-plugin` install strategies.
- **Counting convention:** 24 non-plugin entries plus 6 reserved Agent Plugins v1.0.0 entries make `AGENTS.length` 30. Preferred resolution replaces the Claude Code, Cursor, and OpenAI Codex config entries with their plugin entries, adds the plugin-only GitHub Copilot and Kiro surfaces, and keeps VS Code on its config-file path. The result is 26 preferred surfaces with three explicit legacy config alternatives and one experimental VS Code plugin entry. `registry.test.ts` pins the exact counts, so adding an agent or plugin variant must update those assertions deliberately.
- Describes each agent's config file locations, credential style, transport type, install strategy, source URL, and platform-specific gotchas.
- Every entry publishes a support tier and verification metadata. Documentation or package-conformance evidence can establish `COMPATIBLE`; only retained client-runtime receipts may establish `NATIVE` or `VERIFIED`.
- The catalog reserves `agent-plugin` install strategy entries for 6 clients (Claude Code, Cursor, VS Code, OpenAI Codex, GitHub Copilot, Kiro). Package-conformance checks cover Claude Code, Cursor, OpenAI Codex, and Kiro. VS Code and GitHub Copilot plugin entries remain `EXPERIMENTAL` until runtime receipts exist.
- Renders agent configuration entries into JSON, JSONC, TOML, or YAML in `src/render.ts`.
- The `<apiUrl>` placeholder in `transportFields["remote-http"]` resolves to the Streamable-HTTP MCP endpoint (`<apiUrl>/api/mcp` after stripping any stale `/api/v1` suffix). The stdio `LYRASHIELD_API_URL` env block uses the base `apiUrl` directly.
- Exports schemas and types in `src/schema.ts` and `src/types.ts` used by the CLI installer and rule renderer.

## Main exports

- `getAgent(id)`, `listAgents()`, `agentsByStrategy(strategy)`, `AGENTS` — `agentsByStrategy("agent-plugin")` returns the 6 launch-client entries. Consumers must use each entry's `supportTier` and `verification` fields instead of inferring support from presence alone.
- `renderEntry(...)`, `renderConfig(...)`, `assertServerName(...)`
- Types: `AgentEntry`, `ConfigLocation`, `CredentialStyle`, `InstallStrategy`, `SupportTier`, `IntegrationVerification`, `Transport`

## See also

- `packages/cli/README.md`
- `packages/cli/src/commands/install.ts`
- `packages/agent-rules/README.md`
- `packages/agent-plugin/README.md`
