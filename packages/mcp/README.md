# @lyrashield/mcp

The **LyraShield AI** [Model Context Protocol](https://modelcontextprotocol.io) server. It lets an AI coding tool run verified security scans, read findings, and drive the fix → verify loop against your LyraShield workspace — without leaving the editor.

Built on the official `@modelcontextprotocol/sdk`. Available two ways: this **stdio** package (local editors) and a hosted **remote (Streamable HTTP)** endpoint at `/api/mcp` for cloud platforms that can't run a local server (Lovable, Bolt.new, Replit, v0). The server is also distributed as a portable Agent Plugin via [`@lyrashield/agent-plugin`](../agent-plugin/README.md) (Agent Plugins v1.0.0).

## What it can do

Every tool calls the LyraShield REST API with a workspace API key or OAuth bearer. **Mutating tools require human approval** — the server asks you in-editor (MCP elicitation) before starting a scan, recording a fix proposal, or queueing a retest.

| Tool                                  | Kind  | What it does                                                  |
| ------------------------------------- | ----- | ------------------------------------------------------------- |
| `lyrashield_list_workspaces`          | read  | List workspaces this key can access                           |
| `lyrashield_list_targets`             | read  | List targets (repos/apps/APIs) in a workspace                 |
| `lyrashield_get_scan_status`          | read  | Status, timing, and events for a scan                         |
| `lyrashield_get_findings`             | read  | Findings, filterable by severity/target                       |
| `lyrashield_explain_finding`          | read  | Full detail + plain-language explanation of a finding         |
| `lyrashield_generate_fix_plan`        | read  | Assemble a remediation plan from a finding                    |
| `lyrashield_get_launch_readiness`     | read  | GO / GO_WITH_CONDITIONS / NO_GO verdict                       |
| `lyrashield_create_pr_security_recap` | read  | Markdown recap for a PR comment                               |
| `lyrashield_check_diff`               | read  | Fast **advisory** heuristic pre-filter on a diff (not a scan) |
| `lyrashield_scan_target`              | write | Start a scan on a target                                      |
| `lyrashield_run_pr_scan`              | write | Start a PR-focused (CHECK_PR) scan                            |
| `lyrashield_record_fix_proposal`      | write | Record a fix proposal on a finding                            |
| `lyrashield_verify_fix`               | write | Queue a retest to verify a fix                                |
| `lyrashield_create_report`            | write | Generate a shareable report                                   |

> `lyrashield_check_diff` is a lightweight local heuristic (obvious hardcoded secrets, `eval`, unsafe HTML, SQL concatenation) meant as a pre-PR pre-filter. It is **not** a scanner — run `lyrashield_run_pr_scan` for verified, exploit-validated results.
>
> `lyrashield_scan_target` and `lyrashield_run_pr_scan` accept `targetId` directly, or you can pass `repo` (e.g. `ecryptoguru/lyrashield-ai`, `https://github.com/ecryptoguru/lyrashield-ai.git`, or `git@github.com:ecryptoguru/lyrashield-ai.git`) to create or reuse a target automatically. `auto: true` detects the current git repo only in the local stdio server; hosted MCP clients must pass `repo` or `targetId`.
>
> **Mode guide:** choose the cheapest mode that fits the question — `SAFE` for pre-PR, `QUICK` for fast checks, `STANDARD` for repo/launch review, `DEEP` for deep or compliance review. Deeper modes consume more compute and, in the SaaS plan, more billable minutes. `lyrashield_scan_target` defaults to `STANDARD`; `lyrashield_run_pr_scan` defaults to `SAFE`.

## Setup

1. Create a workspace API key in LyraShield: **Settings → API keys** (read-only or read & write).
2. Add the server to your tool. It needs two environment variables:
   - `LYRASHIELD_API_KEY` — your `lsk_…` key
   - `LYRASHIELD_API_URL` — your LyraShield app URL (defaults to `http://localhost:3000`)

### Claude Code / Cursor / Windsurf / Gemini CLI (the `mcpServers` shape)

```json
{
  "mcpServers": {
    "lyrashield": {
      "command": "npx",
      "args": ["-y", "@lyrashield/mcp"],
      "env": {
        "LYRASHIELD_API_KEY": "lsk_your_key",
        "LYRASHIELD_API_URL": "https://app.lyrashieldai.com"
      }
    }
  }
}
```

Claude Code one-liner: `claude mcp add lyrashield -e LYRASHIELD_API_KEY=lsk_… -e LYRASHIELD_API_URL=https://app.lyrashieldai.com -- npx -y @lyrashield/mcp`

### VS Code (note: the root key is `servers`, not `mcpServers`)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "lyrashield": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@lyrashield/mcp"],
      "env": {
        "LYRASHIELD_API_KEY": "lsk_your_key",
        "LYRASHIELD_API_URL": "https://app.lyrashieldai.com"
      }
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

OpenAI Codex keeps MCP servers under the `[mcp_servers.<name>]` table, and the API key/url must live in a dedicated `[mcp_servers.<name>.env_vars]` sub-table — a plain `env` key is silently ignored.

```toml
[mcp_servers.lyrashield]
command = "npx"
args = ["-y", "@lyrashield/mcp"]

[mcp_servers.lyrashield.env_vars]
LYRASHIELD_API_KEY = "lsk_your_key"
LYRASHIELD_API_URL = "https://app.lyrashieldai.com"
```

Per-client config for OpenCode, Kilo Code, Cline, Zed, and the cloud platforms lives in the LyraShield docs.

### Credentials resolution

The server reads `LYRASHIELD_API_KEY` and `LYRASHIELD_API_URL` from the environment first. If those are absent, it falls back to `~/.lyrashield/credentials.json` — the credentials file written by `lyrashield login` (with `0o600` permissions). This means `npx -y @lyrashield/mcp` works without any env vars after a single `lyrashield login`.

`lyrashield login` uses an OAuth device flow: it opens a browser to approve the CLI, writes the resulting token to `~/.lyrashield/credentials.json`, and falls back to `LYRASHIELD_API_KEY` from the environment if the browser flow is unavailable. `packages/credentials` is the single source of truth for that file — its location, env-over-file precedence, default API URL, and normalization — shared by the CLI and MCP server so the two cannot drift.

### Remote (Streamable HTTP) — for cloud editors

Point any remote-MCP-capable client at the hosted endpoint. Two authentication methods are supported:

**API key (Bearer token):**

```json
{
  "mcpServers": {
    "lyrashield": {
      "type": "http",
      "url": "https://app.lyrashieldai.com/api/mcp",
      "headers": { "Authorization": "Bearer lsk_your_key" }
    }
  }
}
```

**OAuth 2.0 (hosted):** remote clients that support OAuth 2.0 (per the MCP spec) can authenticate through the hosted OAuth flow at `/oauth/consent` with workspace selection and optional write scope. The discovery endpoints are `.well-known/oauth-authorization-server` and `.well-known/oauth-protected-resource`. Remote connections are read-only by default; write actions require explicit scope and approval.

The remote endpoint runs the same guard and tools as stdio. Because a stateless HTTP request has no way to prompt a human, **mutating tools are refused over remote by default** — run those from the local stdio server (which prompts you), or use a pre-authorized trusted automation. Read-only tools work everywhere.

## Approval behavior

- **In an editor that supports elicitation** (Cursor, VS Code, Claude Code, …): you get an in-editor approve/deny prompt before any mutating tool runs.
- **In a bare terminal with a TTY**: you're prompted on the controlling terminal.
- **No approval channel available** (e.g. a headless process): mutating tools fail closed.

### Operator-only CI opt-out

Set `LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS=true` only in a documented operator-controlled automation environment. It is not a marketplace or normal-user feature. OAuth clients can never use this bypass; every OAuth write remains scope- and approval-gated.

Read-only tools never prompt. A read-only key is additionally rejected server-side for any write action.

## License

Apache-2.0 — LyraShield AI client artifact. The hosted LyraShield service remains proprietary.
