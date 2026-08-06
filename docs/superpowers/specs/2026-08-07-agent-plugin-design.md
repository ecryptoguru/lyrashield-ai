# LyraShield Agent Plugin — Design Spec

## Goal

Ship a single portable Agent Plugins 1.0.0 package for LyraShield that installs into every supported AI coding client with one command, while keeping the existing per-client installer as a fallback for clients that do not yet support Agent Plugins.

## Context

- `agent-plugins.org` defines a portable package format: a `plugin.json` manifest, a `skills/` directory of Agent Skills, and an `mcp.json` of stdio / streamable-http / legacy SSE MCP servers.
- At launch (2026-08), Agent Plugins are supported by Claude Code, Cursor, VS Code, GitHub Copilot, Kiro, and OpenAI Codex.
- LyraShield already ships `@lyrashield/mcp` (an MCP 1.30+ server with stdio and Streamable HTTP transports) and `@lyrashield/agent-registry` / `@lyrashield/cli` for 24 per-editor configs.
- The Agent Plugins spec explicitly forbids embedding credentials in `mcp.json` `env` or `headers`; credential storage is client-managed.

## Decisions

| Decision               | Choice                                                                                                         | Rationale                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Credential model       | `@lyrashield/mcp` falls back to `~/.lyrashield/credentials.json` when `LYRASHIELD_API_KEY` is not set          | Best UX: user runs `lyrashield login` once, the plugin works in any editor, and no secret appears in the portable config. |
| Package strategy       | New `packages/agent-plugin` is the canonical plugin directory; CLI copies it into client-specific plugin paths | Keeps the package versioned, testable, and independent of per-client filesystem conventions.                              |
| Rollout scope          | Add Agent Plugin install paths for the six launch clients in one branch                                        | Aligns with the request to “do all,” with conformance tests validating the package before the CLI/registry changes.       |
| Backward compatibility | Keep existing per-client configs and `lyrashield install <agent>` behavior                                     | Clients not yet supporting Agent Plugins continue to work; users can opt into the new path when it is available.          |

## Components

### `packages/agent-plugin` (new)

```text
packages/agent-plugin/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsup.config.ts
├── plugin/                 # canonical portable plugin root
│   ├── plugin.json         # portable Agent Plugins manifest
│   ├── .claude-plugin/     # optional client manifest shim
│   │   └── plugin.json
│   ├── .cursor-plugin/     # optional client manifest shim
│   │   └── plugin.json
│   ├── .codex-plugin/      # optional client manifest shim
│   │   └── plugin.json
│   ├── .kiro-plugin/       # optional client manifest shim
│   │   └── plugin.json
│   ├── mcp.json            # MCP server config
│   └── skills/
│       └── lyrashield/
│           └── SKILL.md    # portable Agent Skill
├── src/
│   ├── index.ts            # exports getPluginDir() and validators
│   └── __tests__/
│       ├── schema.test.ts  # validates plugin.json and mcp.json
│       └── skill.test.ts   # validates SKILL.md frontmatter and body
└── README.md
```

- `plugin/` is the directory the CLI copies into the user’s client-specific plugin path.
- `plugin/plugin.json` targets `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`.
- `plugin/mcp.json` targets `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`.
- Client manifest shims may be generated into `plugin/.<client>-plugin/plugin.json` (e.g. `.claude-plugin`, `.cursor-plugin`, `.codex-plugin`, `.kiro-plugin`) for clients that still discover their native manifest path. These shims are not part of the Agent Plugins portable contract; they are an implementation detail to maximize launch-client compatibility.
- `plugin/mcp.json` contains two server entries:
  - `lyrashield-stdio`: `type: "stdio"`, `command: "npx"`, `args: ["-y", "@lyrashield/mcp"]`, no `env`.
  - `lyrashield-remote`: `type: "streamable-http"`, `url: "https://app.lyrashieldai.com/api/mcp"`, no `headers`.
- `plugin/skills/lyrashield/SKILL.md` is generated at build time by importing `renderMarkdownBody` from `@lyrashield/agent-rules`, so the portable skill never drifts from the existing rules body.

### `packages/mcp`

- Add `packages/mcp/src/credentials.ts` that mirrors the CLI credential file format (`~/.lyrashield/credentials.json`, `0o600`).
- Update `packages/mcp/src/stdio-transport.ts` to resolve the effective `apiKey` and `apiUrl` before creating the server:
  1. `process.env.LYRASHIELD_API_KEY` / `LYRASHIELD_API_URL`
  2. `~/.lyrashield/credentials.json`
  3. Default `apiUrl` to `https://app.lyrashieldai.com`; fail clearly if no `apiKey` is found.
- Update `packages/mcp/src/server.ts` to accept an already-resolved `toolContext`.
- Add tests for the credentials fallback and the “no key” error path.

### `packages/agent-registry`

- Add `InstallStrategy` value `"agent-plugin"`.
- Add `pluginLocations: ConfigLocation[]` to `AgentEntry`. Each entry gives a client-specific directory where the plugin should be installed (e.g. `~/.claude/plugins/lyrashield`, `~/.cursor/plugins/lyrashield`, etc.).
- Add or update registry entries for the six launch clients with `installStrategy: "agent-plugin"`:
  - Claude Code
  - Cursor
  - VS Code
  - OpenAI Codex
  - GitHub Copilot
  - Kiro
- Keep all existing `config-file`, `vendor-cli`, and `guided-manual` entries unchanged.

### `packages/cli`

- Extend `packages/cli/src/commands/install.ts` to branch on `agent.installStrategy === "agent-plugin"`.
- New installer path `packages/cli/src/installers/agent-plugin.ts`:
  - Resolve the client-specific plugin directory from the registry.
  - Copy the canonical plugin directory (`packages/agent-plugin/plugin/`) into the client-specific plugin path. Never symlink: symlinks resolving outside the plugin root violate the Agent Plugins containment rules.
  - Ensure `plugin.json` and `mcp.json` validate against the Agent Plugins schemas.
  - If no credentials file exists, prompt the user to run `lyrashield login` and exit with a helpful error rather than writing a secret into the plugin.
- Extend `packages/cli/src/commands/uninstall.ts` to remove the client plugin directory.
- Update `packages/cli/src/commands/init.ts` to prefer Agent Plugin installs for clients that support it, falling back to the current behavior.
- Add `--transport stdio|remote-http` continues to work for non-Agent-Plugin clients.

### Marketing / docs

- Add an “Agent Plugin” section to `/docs/integrations`.
- Update per-client guides for the six launch clients to mention Agent Plugin install as the preferred method.
- Keep existing guides for clients without Agent Plugin support.

## User flow

1. User runs `npx lyrashield login` and pastes an API key. The CLI stores it in `~/.lyrashield/credentials.json`.
2. User runs `npx lyrashield init` or `npx lyrashield install claude-code`.
3. CLI detects that Claude Code supports Agent Plugins and copies the plugin root from `packages/agent-plugin/plugin/` into the client-specific directory defined in the registry.
4. Claude Code discovers `plugin.json`, loads the skill, and launches the stdio MCP server.
5. The MCP server starts with no `LYRASHIELD_API_KEY` in its env, reads `~/.lyrashield/credentials.json`, and is ready.

## Error handling

- Missing credentials: MCP server returns a clear error and the CLI prompts for `lyrashield login`.
- Invalid `plugin.json` / `mcp.json`: CLI install fails fast with schema violation details.
- Client plugin directory already exists: CLI prompts to overwrite or skip.
- Remote MCP (`streamable-http`) requires the user to add `Authorization: Bearer <LYRASHIELD_API_KEY>` in the client UI; the portable `mcp.json` never contains this header, in compliance with the Agent Plugins spec.
- Client not yet supported: falls back to the existing per-client config install.

## Security

- The portable `mcp.json` never contains `LYRASHIELD_API_KEY`.
- Credentials file remains `0o600` and in the user’s home directory, outside the plugin root.
- The MCP server reads the file with `node:fs/promises` and does not log its contents.
- Plugin file containment: the CLI refuses to copy or resolve paths outside the plugin root, mirroring the Agent Plugins containment rules.
- `command: "npx"` in `mcp.json` is a bare executable token. The client resolves it via `PATH`. This is client-defined behavior in the spec; if a client fails to resolve `npx`, the user can fall back to the existing per-client config or wrap `npx` in a local script.

## Testing plan

- `packages/agent-plugin`
  - Schema tests: `plugin.json` and `mcp.json` pass the published `agent-plugins.org` JSON schemas.
  - Skill tests: `SKILL.md` has valid frontmatter and a non-empty body.
- `packages/mcp`
  - Credentials fallback: env takes precedence over file; missing key yields a clear error.
  - The credentials file is read with correct permissions and not logged.
- `packages/agent-registry`
  - Snapshot tests include the new Agent Plugin entries.
  - `listAgents()` and `getAgent()` continue to return all 24+ entries.
- `packages/cli`
  - Install/uninstall snapshot tests for Agent Plugin-capable clients.
  - Conformance tests that the generated plugin directory validates against the Agent Plugins spec.

## Monitoring / future work

- Track which clients in the registry still lack Agent Plugin support.
- Evaluate publishing `@lyrashield/agent-plugin` to npm once the package is stable, so clients can install directly from a registry or marketplace.
- Add a conformance CI job that fetches the latest `agent-plugins.org` schemas and re-validates `packages/agent-plugin/plugin/plugin.json` and `packages/agent-plugin/plugin/mcp.json`.
