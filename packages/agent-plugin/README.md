# @lyrashield/agent-plugin

The source checkout prepares `0.1.31` as an unpublished release candidate. The latest public npm
version remains `0.1.30` until the coordinated release is published.

Candidate **Agent Plugins 1.0.0** package for LyraShield AI. It bundles LyraShield's MCP
connection and skills into one portable plugin. Conforming clients can load the canonical
manifest; generated client shims cover the launch clients listed below.

## What's in the box

The canonical plugin lives in the `plugin/` directory:

- `plugin/plugin.json` — the manifest (name, version, description, author, homepage,
  repository, license, keywords).
- `plugin/mcp.json` — OAuth-first Streamable HTTP MCP server config. The hosted service
  performs authorization discovery and keeps write scope bound to the connection grant.
- `plugin/skills/lyrashield/SKILL.md` — the skill body, generated from the
  `@lyrashield/agent-rules` policy. It now includes a mode/cost guide, example
  user prompts and matching tool calls and a minute-awareness note so the agent
  picks the cheapest depth that fits the request.

## Client manifest shims

`buildPlugin()` generates client-specific descriptors. Their presence in the package does not
create a discovery path; each client still controls activation:

- `.claude-plugin/` — Claude Code
- `.cursor-plugin/` — Cursor
- `.codex-plugin/` — Codex
- `.kiro-plugin/` — Kiro

The staged Codex marketplace root uses the native `streamable-http` transport. Claude and
Copilot marketplace descriptors are preparation artifacts. Their presence does not establish a
published install path or authenticated client acceptance.

## Current customer setup

Do not install from the mutable marketplace preparation branch or substitute public plugin
`0.1.30` without matching portable-schema validation. Claude Code, Codex, Copilot and VS Code
plugin instructions remain pending a reviewed matching immutable package release.

Use published `@lyrashield/mcp@0.2.11` for the direct MCP fallback and
`npx -y lyrashield@0.2.13 login --oauth` for local stdio authentication in the same OS account.
Node.js 24 or newer is required. Merge configuration manually while CLI config writes and skill
installation remain withheld pending release. Preserve existing servers and keep credentials out
of shared configuration.

| Client             | Current guided fallback                                                    | Client config                                      |
| ------------------ | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Claude Code        | [Direct MCP](https://lyrashieldai.com/docs/integrations/claude-code)       | `.mcp.json`, `mcpServers`                          |
| OpenAI Codex       | [Direct MCP](https://lyrashieldai.com/docs/integrations/openai-codex)      | `~/.codex/config.toml`, `[mcp_servers.lyrashield]` |
| GitHub Copilot CLI | [Direct MCP](https://lyrashieldai.com/docs/integrations/github-copilot)    | `~/.copilot/mcp-config.json`, `type: "local"`      |
| VS Code            | [Direct MCP](https://lyrashieldai.com/docs/integrations/vscode)            | `.vscode/mcp.json`, `servers`, `type: "stdio"`     |
| Kiro               | [MCP settings](https://lyrashieldai.com/docs/integrations/kiro)            | `.kiro/settings/mcp.json`, `mcpServers`            |
| Cursor             | [Client-specific guide](https://lyrashieldai.com/docs/integrations/cursor) | Follow its current published setup contract        |

Package conformance checks describe source artifacts only. Restart the client, confirm server
and tool discovery, then make an authenticated read-only workspace call. Those checks and vendor
marketplace publication require separate receipts; a staging export cannot establish them.

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

## Authentication and approvals

The canonical, Claude, Cursor and Codex artifacts connect to the hosted Streamable HTTP
endpoint without embedding a secret. The client follows hosted OAuth discovery, selects one
workspace and receives read scope by default. Write scope is optional. Consent can delegate named
workflows for selected targets and scan profiles so matching calls need no additional LyraShield
review; mutating calls from API-key callers receive a `connect_required` response pointing at OAuth
connect and the legacy exact-input approval path remains only for nondelegated hosted credentials.

The staged Kiro artifact targets unpublished `@lyrashield/mcp@0.2.12`; do not install that
candidate before coordinated release. For the current direct fallback, use
`npx -y @lyrashield/mcp@0.2.11` and run `npx -y lyrashield@0.2.13 login --oauth`
first; the server then reads the user-only `~/.lyrashield/credentials.json` file. Environment
variables remain an explicit CI/headless fallback, with `LYRASHIELD_API_KEY` taking precedence.
Headless writes without an approval channel fail closed on the local stdio server; API-key writes
against the remote endpoint receive `connect_required` instead.

> **Note:** per the Agent Plugins v1.0.0 spec, the `mcp.json` `env` block must **not**
> contain `PLUGIN_ROOT` or `PLUGIN_DATA`. Those keys are reserved for the host and are
> injected at load time.

## Version and release receipts

- Candidate package: `@lyrashield/agent-plugin` 0.1.31 (unpublished); runtime: Node.js 24 or newer.
- Standard schema: Agent Plugins 1.0.0.
- `pnpm --filter @lyrashield/agent-plugin test` validates generated shims, schemas,
  OAuth-first manifests, mutation exclusions, artifact versions and the public export boundary.
- `pnpm --filter @lyrashield/agent-plugin export:marketplace <directory>` creates the
  reviewable marketplace payload and provenance manifest.

An exported or validated artifact is not proof that a vendor marketplace accepted, published
or live-tested it. Public listings remain separate vendor-controlled submissions.

## See also

- [`packages/mcp/README.md`](../mcp/README.md) — the MCP server this plugin packages.
- [`packages/agent-registry/README.md`](../agent-registry/README.md) — the agent catalog
  and install strategies, including `agent-plugin`.
- [`packages/cli/README.md`](../cli/README.md) — the `lyrashield` CLI, which installs direct
  integrations or prints the client-owned marketplace/settings step.
