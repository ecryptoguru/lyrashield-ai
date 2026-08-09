# @lyrashield/agent-plugin

Portable **Agent Plugins 1.0.0** package for LyraShield AI. It bundles LyraShield's MCP
server and skills into a single portable plugin that any client supporting the
[vendor-neutral Agent Plugins v1.0.0](https://agent-plugins.org) standard can discover and
load — no per-client config editing required.

## What's in the box

The canonical plugin lives in the `plugin/` directory:

- `plugin/plugin.json` — the manifest (name, version, description, author, homepage,
  repository, license, keywords).
- `plugin/mcp.json` — OAuth-first Streamable HTTP MCP server config. The hosted service
  performs authorization discovery and keeps write scope approval-gated.
- `plugin/skills/lyrashield/SKILL.md` — the skill body, generated from the
  `@lyrashield/agent-rules` policy. It now includes a mode/cost guide, example
  user prompts and matching tool calls, and a minute-awareness note so the agent
  picks the cheapest depth that fits the request.

## Client manifest shims

`buildPlugin()` generates a copy of `plugin.json` into a per-client directory so each
launch client can find the plugin in the location it expects:

- `.claude-plugin/` — Claude Code
- `.cursor-plugin/` — Cursor
- `.codex-plugin/` — Codex
- `.kiro-plugin/` — Kiro

Each shim directory contains a copy of `plugin.json` pointing back at the canonical
`plugin/` contents.

## API

- `getPluginDir()` — returns the absolute path to the canonical `plugin/` directory.
- `validatePlugin(root)` — validates `plugin.json` and `mcp.json` against their AJV
  schemas; throws on any violation.
- `buildPlugin()` — generates `plugin/skills/lyrashield/SKILL.md` from the
  `@lyrashield/agent-rules` policy and emits the client manifest shims
  (`.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/`, `.kiro-plugin/`).

## Build

```bash
pnpm --filter @lyrashield/agent-plugin build:plugin   # regenerate SKILL.md + client shims
pnpm --filter @lyrashield/agent-plugin test
```

## Credentials resolution

The bundled MCP server (`npx -y @lyrashield/mcp`) resolves credentials the same way the
standalone server does: it reads `LYRASHIELD_API_KEY` and `LYRASHIELD_API_URL` from the
environment first, and if those are absent it falls back to
`~/.lyrashield/credentials.json` (written by `lyrashield login`, `0o600` perms). This
means a single `lyrashield login` is enough for the plugin to work — no env vars required.

> **Note:** per the Agent Plugins v1.0.0 spec, the `mcp.json` `env` block must **not**
> contain `PLUGIN_ROOT` or `PLUGIN_DATA`. Those keys are reserved for the host and are
> injected at load time.

## See also

- [`packages/mcp/README.md`](../mcp/README.md) — the MCP server this plugin packages.
- [`packages/agent-registry/README.md`](../agent-registry/README.md) — the agent catalog
  and install strategies, including `agent-plugin`.
- [`packages/cli/README.md`](../cli/README.md) — the `lyrashield` CLI, which installs the
  plugin to supported agents via `init` / `install`.
