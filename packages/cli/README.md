# LyraShield CLI 0.2.12

The `lyrashield` command-line interface installs, configures, and drives LyraShield scans from a terminal or CI pipeline.

## Quick start

```sh
npx lyrashield login --oauth      # hosted PKCE OAuth login (recommended)
npx lyrashield use <workspace>
npx lyrashield project use        # detect the current git repo and set it as the default project
npx lyrashield scan               # scan the default project (uses default mode)
npx lyrashield pr-scan --auto     # run a bounded PR check on the current repo
```

You can also set `LYRASHIELD_API_KEY` (and optionally `LYRASHIELD_API_URL`) in the environment. `LYRASHIELD_API_URL` defaults to `https://app.lyrashieldai.com`.

## Usage

```sh
lyrashield <command> [args] [--json]
```

## Commands

### Authentication and setup

- `login --oauth` — connect through hosted OAuth consent using PKCE, then save the token and selected workspace to `~/.lyrashield/credentials.json` with `0o600` permissions. Failed login preserves existing credentials.
- `login` — securely enter or pipe a workspace API key. Environment credentials retain precedence; OAuth failures never silently switch authentication methods.
- `logout` — remove stored credentials
- `use <workspace>` — set the default workspace for subsequent commands
- `doctor` — diagnose credentials, API reachability, and locally detected agents

### Agent installation

- `agents` — list the complete registry with detection state, evidence-backed support tier, and verification metadata
- `init` — detect and configure all installed agents using that client's documented transport and install path. When a client requires its own marketplace, UI, or config merge, `init` prints the exact next step instead of copying files into an unrecognized directory.
- `install <agent> [--transport stdio|remote-http] [--global|--project] [--inline-secret] [--dry-run]` — add LyraShield to a single agent. Cursor accepts a local Agent Plugin copy; Codex, Claude Code, and GitHub Copilot use their marketplace commands; Kiro uses its documented MCP settings file. `--dry-run` previews every path without executing vendor CLIs or writing files.
- `uninstall <agent>` — remove a CLI-managed LyraShield config or plugin. Marketplace and UI installs return client-specific removal guidance.
- `rules add <agent>|remove <agent>|check` — add, remove, or validate an agent rules file (`AGENTS.md`, `CLAUDE.md`, etc.)

`install` refuses to write raw secrets into shared-by-convention files unless you pass `--inline-secret` and the file is gitignored. Use `--dry-run` to preview the config change without writing it.

### Project defaults

- `project use [path] [--repo <repo>] [--name <name>]` — detect the current git repo (or use the given path, owner/repo, HTTPS URL, or SSH URL) and set it as the default project
- `project list` — list workspace targets; the default project is marked with `*`
- `project switch <targetId>` — switch the default project to an existing target
- `project current` — show the current default project
- `project clear` — clear the default project

The default project is stored in `~/.lyrashield/project.json` (mode `0o600`). Once set, `lyrashield scan` can run without `--target`. The default project is workspace-scoped; if you switch workspace with `lyrashield use <workspace>`, a saved default from another workspace is ignored.

### Targets and scans

- `scan [--target <targetId>] [--goal <goal>] [--mode <mode>] [--auto] [--repo <repo>] [--wait|--watch] [--timeout <s>] [--poll-interval <s>]` — start a scan
  - Default mode is `STANDARD`; use `pr-scan` for a bounded `QUICK` pre-PR check. `SAFE` remains an accepted compatibility alias for repository targets.
  - Goals: `CHECK_PR`, `TEST_APP`, `LAUNCH_REVIEW`, `WEEKLY_MONITOR`, `FULL_PENTEST`, `COMPLIANCE_REVIEW`
  - Modes: `SAFE`, `QUICK`, `STANDARD`, `DEEP`, `CUSTOM`
  - With no target and no default project, pass `--auto` to detect the current git repo and create or reuse a target
  - Pass `--repo` as `owner/repo`, an HTTPS URL, or an SSH URL (e.g. `ecryptoguru/lyrashield-ai`, `https://github.com/ecryptoguru/lyrashield-ai.git`, `git@github.com:ecryptoguru/lyrashield-ai.git`)
  - `--wait`/`--watch` polls the scan until a terminal state; `--timeout` bounds the wait in seconds (default 1800, max 86400) and `--poll-interval` sets seconds between polls (default 5, minimum 1). The scan id is printed to stderr immediately on acceptance; status transitions go to stderr while waiting, including in `--json` mode (stdout stays a single final document). `Ctrl+C` stops waiting only — the scan keeps running and the printed `status <id> --watch` command resumes it. A scan that ends other than `COMPLETED` exits `7`; the deadline exits `8`; `SIGINT` exits `130`. `COMPLETED` means execution finished — it is not a security verdict.
- `preflight [--target <targetId>] [--goal <goal>] [--mode <mode>] [--workspace <workspaceId>] [--workflow <workflow> --base <ref> --head <ref>] [--attachment <id>]` — advisory read-only check of whether `scan` would currently be admitted for the target. It evaluates the same permission, plan, domain-proof and entitlement gates server-side without starting a scan, claiming a trial, or consuming the free-URL allowance; the authoritative check still runs at scan creation. Exit `0` when allowed, exit `1` on an eligibility denial (`allowed:false` — a successful read), and the usual codes for usage (`2`), auth (`3`), network (`4`), rate-limit (`5`) and plan refusal (`6`). Supports `--json`; with no `--target`, the saved default project is used when it matches the workspace.
- `pr-scan [--auto] [--repo <owner/repo>] [--mode <mode>] [--wait|--watch] [--timeout <s>]` — shortcut for `scan --goal CHECK_PR --mode QUICK`; supports the same wait flags
- `status [scanId] [--operation <operationId>] [--watch|--wait] [--timeout <s>] [--poll-interval <s>]` — list scans or inspect one scan. `--watch` follows a scan to its terminal state; `--operation <id> --watch` waits on a durable submission operation and follows the recorded scan reference it produced, within the same timeout budget.
- `cancel <scanId> [--idempotency-key <key>]` — request cancellation of a queued or running scan. If the scan is already terminal or finalizing (HTTP 409), the command re-reads and reports the true status: exit `0` when already `CANCELLED`, exit `1` otherwise.
- `targets [--name ... --type ... --url ... --repo ...]` — list or create targets
- `targets remove <targetId>` — soft-delete a target; its history is retained, it is hidden from readers and the plan cap slot is freed
- `targets verify-domain <targetId> [--issue|--check]` — show domain-control status for a WEB_APP/API target in the configured workspace. `--issue` returns the DNS TXT host, value, and challenge expiry; publish that record, then use `--check`. Issuing replaces the previous token and verified status. The TXT value is returned only on issue; save it before exiting. All proof operations require target validation permission. Supports `--json`; invalid targets, permission failures, missing/expired proofs, and failed DNS checks exit nonzero. DNS control does not establish application security.
- `readiness [--target <targetId>]` — get the launch-readiness gate result (`READY`, `NOT_READY` or `INSUFFICIENT_EVIDENCE`)

### Scan mode guide

Deeper modes consume more compute and take longer. Choose the least intensive mode that answers the question.

| Intent                        | Goal                | Mode       |
| ----------------------------- | ------------------- | ---------- |
| Pre-PR check                  | `CHECK_PR`          | `QUICK`    |
| Quick check                   | `TEST_APP`          | `QUICK`    |
| Standard repo review          | `TEST_APP`          | `STANDARD` |
| Launch review                 | `LAUNCH_REVIEW`     | `STANDARD` |
| Authorized repository pentest | `FULL_PENTEST`      | `DEEP`     |
| Compliance review             | `COMPLIANCE_REVIEW` | `DEEP`     |
| Weekly monitor                | `WEEKLY_MONITOR`    | `QUICK`    |

### Findings and fixes

- `findings [--severity ...] [--status ...] [--target ...] [--scan ...] [--verified ...] [--stats]` — list findings
- `explain <findingId>` — show full finding detail and plain-language guidance
- `fix-plan <findingId>` — **read-only** remediation plan assembled from the finding's recorded detail
- `fix-plan create <findingId> --summary <summary>` — record a fix proposal on a finding (summary must be ≥ 10 characters)
- `verify <findingId>` — queue a retest of a finding

### Local checks and CI

- `check-diff [--staged] [--base <ref>] [--head <ref>] [--sarif <file>]` — fast advisory diff check for obvious risky patterns; not a substitute for a full recorded scan
- `gate [--fail-on HIGH|MEDIUM|LOW] [--staged] [--base <ref>] [--head <ref>] [--sarif <file>] [--target <targetId>]` — combine local diff patterns with that target's open findings and fail at the chosen severity threshold. Without `--target` (or a saved default project from `project use`), only the local diff checks gate the PR — never the whole workspace's findings.
- `gate --verdict [--target <id>]` — return the launch-gate verdict for the target instead of the diff-severity gate, with exit code `0` (READY), `1` (NOT_READY), or `2` (insufficient evidence or error — fails closed).

The root GitHub Action v2 source supports local `SAFE` and `AGGRESSIVE` modes only. It rejects `DEEP` with directions to the hosted app, MCP server, or REST API instead of silently reducing coverage.

### Reports and approvals

- `report [--title ... --scan <scanId> --type executive|developer|compliance]` — list or create reports
- `approvals list|create <actionName>|approve <approvalId>|deny <approvalId>` — manage agent-approval requests
- `mcp call <tool> [--input '{...}']` — call a remote MCP tool
- `hook install` — install a pre-commit hook that runs `lyrashield check-diff`

## Exit codes

- `0` — success
- `1` — command failed, or `gate` found findings at/above the threshold; `gate --verdict` returns NOT_READY; `cancel` returns it when the scan is already terminal or finalizing (the true status is reported); `preflight` returns it when the eligibility read succeeds but the scan would be denied (`allowed:false`)
- `2` — usage or validation error; `gate --verdict` returns it on insufficient evidence or any error (fail-closed)
- `3` — authentication or authorization error (HTTP 401/403)
- `4` — network or other API error
- `5` — rate limited (HTTP 429)
- `6` — plan or agent-minute balance refusal (HTTP 402); prints "Plan or agent-minute balance does not allow this. Open Billing."
- `7` — watched work ended without success: a scan reached a terminal state other than `COMPLETED` (`FAILED`, `CANCELLED`, `PARTIAL`, `STOPPED_BUDGET`, `TIMED_OUT`), or a watched operation ended `FAILED`/`CONFLICT`
- `8` — `--wait`/`--watch` deadline elapsed before a terminal state; the scan keeps running and the printed `status <id> --watch` command resumes the wait
- `130` — `SIGINT` (`Ctrl+C`) while waiting; the scan keeps running server-side and the recovery hint on stderr says how to resume or cancel

## Global flags

- `--json` — machine-readable output (`{ ok: true/false, data|error }`)
- `--version` — print version
- `--help` / `-h` — show usage
- `NO_COLOR=1` — disable ANSI colors

## Environment

- `LYRASHIELD_API_KEY` — required; the workspace API key (`lsk_...`)
- `LYRASHIELD_API_URL` — optional; defaults to `https://app.lyrashieldai.com`
- `NO_COLOR=1` — optional; disables colored terminal output

### Importing SARIF

`lyrashield scan --target <targetId> --sarif <report.sarif>` validates the file before submitting a scan and imports third-party detections through `POST /api/v1/scans/{id}/artifacts/sarif`. Imports never establish scanner coverage or independently verified findings. If import fails after submission, retry with `lyrashield scan --scan-id <existingScanId> --sarif <report.sarif>`; this does not create or charge for another scan.

### Retrying a scan safely

Supply `--idempotency-key <request-id>` when a request may be retried across CLI invocations. Reuse the same key and inputs after a lost response. Changed inputs with the same key conflict; an uncertain failed operation is not automatically resubmitted. Without this flag, each invocation is a new request.

Use `lyrashield status --operation <operationId>` (with `--json` for scripts) to read the server's current status, result reference, and permitted recovery. This reports submission state; follow the returned scan ID to inspect scan completion. Access remains bound to the originating credential and workspace.
