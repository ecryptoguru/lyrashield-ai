# @lyrashield/mcp

The **LyraShield AI** [Model Context Protocol](https://modelcontextprotocol.io) server. It lets an AI coding tool run verified security scans, read findings, and drive the fix → verify loop against your LyraShield workspace — without leaving the editor.

Built on the official `@modelcontextprotocol/sdk`. Available two ways: this **stdio** package (local editors) and a hosted **remote (Streamable HTTP)** endpoint at `/api/mcp` for cloud platforms that can't run a local server (Lovable, Bolt.new, Replit, v0).

## What it can do

Every tool calls the LyraShield REST API with your workspace API key. **Mutating tools require human approval** — the server asks you in-editor (MCP elicitation) before starting a scan, recording a fix proposal, or queueing a retest.

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

```toml
[mcp_servers.lyrashield]
command = "npx"
args = ["-y", "@lyrashield/mcp"]
env_vars = ["LYRASHIELD_API_KEY", "LYRASHIELD_API_URL"]
```

Per-client config for OpenCode, Kilo Code, Cline, Zed, and the cloud platforms lives in the LyraShield docs.

### Remote (Streamable HTTP) — for cloud editors

Point any remote-MCP-capable client at the hosted endpoint and authenticate with the same `lsk_` key as a Bearer token:

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

The remote endpoint runs the same guard and tools as stdio. Because a stateless HTTP request has no way to prompt a human, **mutating tools are refused over remote by default** — run those from the local stdio server (which prompts you), or use a pre-authorized trusted automation. Read-only tools work everywhere.

## Approval behavior

- **In an editor that supports elicitation** (Cursor, VS Code, Claude Code, …): you get an in-editor approve/deny prompt before any mutating tool runs.
- **In a bare terminal with a TTY**: you're prompted on the controlling terminal.
- **No approval channel available** (e.g. a headless process): mutating tools fail closed.
- **Trusted, pre-reviewed CI**: set `LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS=true` to skip the remote gate; the local stdio server still prompts interactively.

Read-only tools never prompt. A read-only key is additionally rejected server-side for any write action.

## License

UNLICENSED — © FusionWave AI. Not for redistribution.
