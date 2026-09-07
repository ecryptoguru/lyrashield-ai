# @lyrashield/agent-plugin

Portable **Agent Plugins 1.0.0** package for LyraShield AI. It bundles LyraShield's MCP
connection and skills into one portable plugin. Conforming clients can load the canonical
manifest; generated client shims cover the launch clients listed below.

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

`buildPlugin()` generates client-specific descriptors. Their presence in the package does not
create a discovery path; each client still controls activation:

- `.claude-plugin/` — Claude Code
- `.cursor-plugin/` — Cursor
- `.codex-plugin/` — Codex
- `.kiro-plugin/` — Kiro

Codex installs from the dedicated `codex-plugin/` marketplace root, whose `.mcp.json` uses the
native `streamable-http` transport. Claude and GitHub Copilot use marketplace installation. Kiro
consumes the generated stdio entry through its workspace or user MCP settings file.

## Compatibility status

| Client         | Package artifact       | Current evidence                                 | Recommended setup                        |
| -------------- | ---------------------- | ------------------------------------------------ | ---------------------------------------- |
| Claude Code    | `.claude-plugin/`      | Package-conformance tests                        | Claude marketplace commands              |
| Cursor         | `.cursor-plugin/`      | Package-conformance tests                        | Agent Plugin                             |
| OpenAI Codex   | `.codex-plugin/`       | Package-conformance tests                        | Agent Plugin                             |
| Kiro           | `.mcp.kiro.json`       | Package-conformance tests                        | Merge into Kiro MCP settings after login |
| VS Code        | Portable root manifest | Experimental; no retained client-runtime receipt | `lyrashield install vscode`              |
| GitHub Copilot | Portable root manifest | Experimental; no retained client-runtime receipt | Copilot marketplace commands             |

Package-conformance means the generated manifest, schema, transport, version, and export
boundary passed repository tests. It does not mean every client version has completed an
authenticated runtime matrix. The wider registry contains 30 install entries resolving to 26
preferred client surfaces; use `lyrashield init` or `lyrashield install <agent>` to receive the
correct direct install or client-owned next step. GitHub Copilot remains `EXPERIMENTAL` until a
retained client-runtime receipt exists.

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

The canonical, Claude, Cursor, and Codex artifacts connect to the hosted Streamable HTTP
endpoint without embedding a secret. The client follows hosted OAuth discovery, selects one
workspace, and receives read scope by default. Write scope is optional, and every mutation
still requires exact-argument approval.

Kiro uses the local `npx -y @lyrashield/mcp@0.2.5` stdio adapter. Run `lyrashield login --oauth`
first; the server then reads the user-only `~/.lyrashield/credentials.json` file. Environment
variables remain an explicit CI/headless fallback, with `LYRASHIELD_API_KEY` taking precedence.
Headless writes without an approval channel fail closed.

> **Note:** per the Agent Plugins v1.0.0 spec, the `mcp.json` `env` block must **not**
> contain `PLUGIN_ROOT` or `PLUGIN_DATA`. Those keys are reserved for the host and are
> injected at load time.

## Version and release receipts

- Package: `@lyrashield/agent-plugin` 0.1.24; runtime: Node.js 24 or newer.
- Standard schema: Agent Plugins 1.0.0.
- `pnpm --filter @lyrashield/agent-plugin test` validates generated shims, schemas,
  OAuth-first manifests, mutation exclusions, artifact versions, and the public export boundary.
- `pnpm --filter @lyrashield/agent-plugin export:marketplace -- <directory>` creates the
  reviewable marketplace payload and provenance manifest.

An exported or validated artifact is not proof that a vendor marketplace accepted, published,
or live-tested it. Public listings remain separate vendor-controlled submissions.

## See also

- [`packages/mcp/README.md`](../mcp/README.md) — the MCP server this plugin packages.
- [`packages/agent-registry/README.md`](../agent-registry/README.md) — the agent catalog
  and install strategies, including `agent-plugin`.
- [`packages/cli/README.md`](../cli/README.md) — the `lyrashield` CLI, which installs direct
  integrations or prints the client-owned marketplace/settings step.
