# @lyrashield/agent-registry

The single source of truth for LyraShield AI coding-agent integrations, installers, docs, and rules.

## Purpose

- Defines the supported agent catalog in `src/agents.ts` (e.g., Cursor, VS Code, Claude Code, Windsurf, Zed, Cline).
- Describes each agent's config file locations, credential style, transport type, install strategy, and platform-specific gotchas.
- Renders agent configuration entries into JSON, TOML, or YAML in `src/render.ts`.
- Exports schemas and types in `src/schema.ts` and `src/types.ts` used by the CLI installer and rule renderer.

## Main exports

- `getAgent(id)`, `listAgents()`, `agentsByStrategy(strategy)`
- `renderEntry(...)`, `AGENTS`
- Types: `AgentEntry`, `ConfigLocation`, `CredentialKind`, `InstallStrategy`

## See also

- `packages/cli/README.md`
- `packages/cli/src/commands/install.ts`
- `packages/agent-rules/README.md`
