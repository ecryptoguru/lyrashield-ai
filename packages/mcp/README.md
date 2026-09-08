# @lyrashield/mcp

The **LyraShield AI** [Model Context Protocol](https://modelcontextprotocol.io) server. It lets an AI coding tool run bounded security scans, read findings with their recorded evidence states, and drive the fix → verify loop against your LyraShield workspace — without leaving the editor.

Built on the official `@modelcontextprotocol/sdk`. Available two ways: this **stdio** package (local editors) and a hosted **remote (Streamable HTTP)** endpoint at `/api/mcp` for cloud platforms that can't run a local server (Lovable, Bolt.new, Replit, v0). The server is also distributed as a portable Agent Plugin via [`@lyrashield/agent-plugin`](../agent-plugin/README.md) (Agent Plugins v1.0.0).

Use hosted OAuth when the client supports remote MCP authorization. For local stdio clients,
run `lyrashield login --oauth` once and reuse the user-only credential store. Workspace API keys
are the explicit CI/headless fallback, not the default interactive setup.

## Protocol compatibility

This release uses `@modelcontextprotocol/sdk` 1.30.0. Its latest stable protocol is `2025-11-25`; it also negotiates `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07` for older clients.

- Server identity includes a title, description, website, version, and usage instructions.
- Every tool publishes an input schema, output schema, title, safety annotations, and structured content.
- Tool calls currently publish `execution.taskSupport: "forbidden"`. A returned LyraShield scan ID is a durable product job that clients poll with `lyrashield_get_scan_status`; it is not an MCP protocol task.
- Hosted responses use `Cache-Control: no-store` and vary on authorization and MCP protocol version. The server does not advertise unsupported MCP list-cache metadata.
- The hosted transport remains stateless and fail-closed. It does not advertise durable MCP Tasks because an in-memory task store would make serverless polling, cancellation, and replay unreliable.

See [Protocol conformance](./docs/protocol-conformance.md) for tested behavior and unsupported draft gaps. Tool annotations are client hints only; the server always enforces prompt-injection checks and the connection's server-side authorization independently.

## What it can do

Every tool calls the LyraShield REST API with a workspace API key or OAuth bearer. New write-scoped OAuth consent has one Connect action authorizing the displayed workflows for the workspace, including current and future targets and supported scan profiles. Matching hosted calls run without another LyraShield review and require an idempotency key. Read-only requests remain read-only; existing restricted connections are never silently expanded.

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

> `lyrashield_check_diff` is a lightweight local heuristic (obvious hardcoded secrets, `eval`, unsafe HTML, SQL concatenation) meant as a pre-PR pre-filter. It is **not** a scanner — run `lyrashield_run_pr_scan` for a bounded repository scan with findings, coverage receipts, evidence states, and explicit limitations. Results are not automatically independently verified or exploit-validated.
>
> `lyrashield_scan_target` and `lyrashield_run_pr_scan` accept `targetId` directly, or you can pass `repo` (e.g. `ecryptoguru/lyrashield-ai`, `https://github.com/ecryptoguru/lyrashield-ai.git`, or `git@github.com:ecryptoguru/lyrashield-ai.git`) to create or reuse a target automatically. `auto: true` detects the current git repo only in the local stdio server; hosted MCP clients must pass `repo` or `targetId`.
>
> **Review-depth guide:** choose `QUICK` for pre-PR and fast repository checks, `STANDARD` for general repository or launch reviews, and `DEEP` only for explicit deep/compliance work. `SAFE` is a compatibility alias for repository `QUICK`. `CUSTOM` selects only the repository `DEEP` profile; it does not select a goal. For an authorized repository pentest, send `goal: FULL_PENTEST` with `mode: DEEP` or `CUSTOM`. Deeper modes consume more compute and take longer, so choose the least intensive mode that answers the question. `lyrashield_scan_target` defaults to `STANDARD`; `lyrashield_run_pr_scan` defaults to `QUICK`.

## Setup

1. Run `npx lyrashield login --oauth` and select one workspace in the browser.
2. Add `npx -y @lyrashield/mcp` to the client. No secret belongs in a project config file.

For CI or another environment that cannot complete OAuth, create a workspace API key in
LyraShield under **Settings → API keys** (prefer read-only), then inject these through the
client's user-level secret or environment configuration:

- `LYRASHIELD_API_KEY` — your `lsk_…` key
- `LYRASHIELD_API_URL` — your LyraShield app URL (defaults to `https://app.lyrashieldai.com`)

The interactive examples below use the OAuth credential store and therefore contain no secret.

### Claude Code / Cursor / Gemini CLI (the `mcpServers` shape)

```json
{
  "mcpServers": {
    "lyrashield": {
      "command": "npx",
      "args": ["-y", "@lyrashield/mcp"]
    }
  }
}
```

Claude Code one-liner: `claude mcp add lyrashield -- npx -y @lyrashield/mcp`

### VS Code (note: the root key is `servers`, not `mcpServers`)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "lyrashield": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@lyrashield/mcp"]
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

OpenAI Codex keeps MCP servers under the `[mcp_servers.<name>]` table. Explicit environment values live in `[mcp_servers.<name>.env]`; `env_vars` is an array of names inherited from the parent process.

```toml
[mcp_servers.lyrashield]
command = "npx"
args = ["-y", "@lyrashield/mcp"]
```

For the API-key fallback, add explicit values under `[mcp_servers.lyrashield.env]`, or use
`env_vars = ["LYRASHIELD_API_KEY"]` when Codex should inherit the variable from its parent process.

Per-client config for OpenCode, Kilo Code, Cline, Zed, and the cloud platforms lives in the LyraShield docs.

### Supported-client boundary

The integration registry contains 30 install entries resolving to 26 preferred client surfaces.
Entries are `COMPATIBLE`, `EXPERIMENTAL`, or `DEPRECATED` and record either documentation,
package-conformance, or retained runtime evidence. Presence in the registry means LyraShield can
render or guide that client's current config shape; it does not claim that every client release
completed an authenticated runtime matrix.

- Preferred Agent Plugin installs: Claude Code, Cursor, OpenAI Codex, GitHub Copilot, and Kiro.
  Package-conformance checks cover the four generated shims; GitHub Copilot uses the portable root
  manifest and remains `EXPERIMENTAL` until a retained client-runtime receipt exists.
- VS Code's reserved Agent Plugin entry is experimental and not preferred. Use its verified
  `.vscode/mcp.json` path.
- Config or guided setup: VS Code, Zed, Gemini CLI, OpenCode, Kilo Code, Cline, JetBrains,
  Amp, Roo Code, MiMo Code, Codebuff, Oh-My-Pi, Copilot CLI, Goose, Aider, Devin CLI, Antigravity,
  PiCode, OpenClaw, Hermes, and Devin, subject to each registry entry's support tier.

Run `lyrashield init` for detected clients or `lyrashield install <agent>` for one explicit target.
Do not reuse a nearby client's JSON/TOML shape: root keys, transport names, credential interpolation,
and discovery locations differ.

### Credentials resolution

The server gives `LYRASHIELD_API_KEY` or `LYRASHIELD_OAUTH_ACCESS_TOKEN` precedence over `~/.lyrashield/credentials.json`, the credentials file written by `lyrashield login` (with `0o600` permissions). `LYRASHIELD_API_URL` independently overrides the API origin without replacing a stored OAuth credential. This means `npx -y @lyrashield/mcp` works without any env credential after a single `lyrashield login`.

`@lyrashield/mcp` is an MCP stdio server, not a command-line scanner: start it with `npx -y @lyrashield/mcp` and let your MCP client call its tools. For pull-request CI, use the [LyraShield GitHub Action](../../README.md#github-action) instead.

`lyrashield login --oauth` opens hosted consent using authorization code flow with PKCE and an issuer-bound loopback callback. It saves the selected workspace and tokens only after successful exchange and authenticated workspace discovery. Failed login preserves existing credentials. `lyrashield login` accepts an API key instead. `packages/credentials` owns storage, environment precedence, origin binding, refresh locking, and atomic updates for both CLI and MCP.

### Remote (Streamable HTTP) — for cloud editors

Point any remote-MCP-capable client at the hosted endpoint. Two authentication methods are supported:

**OAuth 2.0 (recommended):** remote clients that support OAuth 2.0 (per the MCP spec) can
authenticate through the hosted OAuth flow at `/oauth/consent` with workspace selection and
the scopes requested by the client. The discovery endpoints are `.well-known/oauth-authorization-server` and
`.well-known/oauth-protected-resource`. Read-only scope stays read-only. Write-scoped consent
clearly discloses automatic workspace access and potential scan usage before connecting.

Register the endpoint without a static authorization header so the client can follow discovery:

```json
{
  "mcpServers": {
    "lyrashield": {
      "type": "http",
      "url": "https://app.lyrashieldai.com/api/mcp"
    }
  }
}
```

**API key fallback (Bearer token):**

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

The remote endpoint runs the same guard and tools as stdio. Hosted responses are never cacheable. OAuth automation binds each call to the connection, workspace, user, OAuth client, authorization version, scopes, expiry, operation, target, profile, and canonical input hash. Current membership and role are checked before returning a stored operation result as well as before execution. Pausing, revoking, expiring, or changing a connection invalidates subsequent calls immediately.

## Authorization behavior

- **New delegated OAuth connection:** Connect is the authorization. Matching hosted mutations require `idempotencyKey`; reuse it only for identical retries.
- **Connection outside its grant:** the call fails closed. Reconnect to authorize the required access.
- **Write-scoped API key or local stdio:** the REST API enforces the credential's scope, current role, target authorization, and budget without a second LyraShield prompt.
- **Read-only credential:** mutations are denied.
- **Legacy hosted nondelegated credential:** historical exact-input approval remains supported; reconnect for automatic workflows.

Coding-agent hosts may impose their own tool permission dialogs. LyraShield cannot suppress those controls. API-key and local stdio calls do not claim the hosted OAuth operation ledger's replay guarantee. Pull requests never auto-merge.

## Compatibility receipts

- Package: `@lyrashield/mcp` 0.2.7; runtime: Node.js 24 or newer.
- SDK lock: `@modelcontextprotocol/sdk` 1.30.0; stable protocol `2025-11-25`, with the older
  negotiated versions listed above.
- `pnpm --filter @lyrashield/mcp test` covers protocol negotiation, stdio/HTTP transport,
  credentials, prompt-injection guards, schemas, structured results, and approval policy.
- A stored OAuth credential is refreshed before the stdio server starts when it is expired or
  within the one-minute refresh window, including when `LYRASHIELD_API_URL` overrides the API
  origin; the rotated credential is atomically persisted. Environment credentials remain immutable
  and retain precedence.
- [`docs/protocol-conformance.md`](./docs/protocol-conformance.md) maps protocol claims to focused
  tests and lists intentionally unsupported draft features.

These are repository compatibility receipts. Production OAuth callbacks, live provider state,
client-specific authenticated browser flows, and marketplace publication require separate live
evidence and are not implied by a green package suite.

## License

Apache-2.0 — LyraShield AI client artifact. The hosted LyraShield service remains proprietary.
