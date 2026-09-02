# LyraShield CLI 0.2.0

The `lyrashield` command-line interface installs, configures, and drives LyraShield scans from a terminal or CI pipeline.

## Quick start

```sh
npx lyrashield login --oauth      # browser-based OAuth device login (recommended)
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

- `login` — open a browser-based OAuth device flow and write the resulting token to `~/.lyrashield/credentials.json` with `0o600` permissions; falls back to `LYRASHIELD_API_KEY` from the environment if the device flow is unavailable
- `logout` — remove stored credentials
- `use <workspace>` — set the default workspace for subsequent commands
- `doctor` — diagnose credentials, API reachability, and locally detected agents

### Agent installation

- `agents` — list the complete registry with detection state, evidence-backed support tier, and verification metadata
- `init` — detect and configure all installed agents. For agents that support the Agent Plugins v1.0.0 standard today (Claude Code, Cursor, OpenAI Codex, GitHub Copilot, Kiro), `init` prefers an **Agent Plugin** install; for all others it falls back to config-file edits.
- `install <agent> [--transport stdio|remote-http] [--global|--project] [--inline-secret] [--dry-run]` — add LyraShield to a single agent. For agents supporting the `agent-plugin` strategy, this installs the portable plugin (from `@lyrashield/agent-plugin`) to the agent's plugin directory; `--dry-run` still works and previews the install without writing.
- `uninstall <agent>` — remove the LyraShield entry from a single agent's config. For `agent-plugin`-strategy agents, this removes the plugin from the agent's plugin directory.
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

- `scan [--target <targetId>] [--goal <goal>] [--mode <mode>] [--auto] [--repo <repo>]` — start a scan
  - Default mode is `STANDARD`; use `pr-scan` for a bounded `QUICK` pre-PR check. `SAFE` remains an accepted compatibility alias for repository targets.
  - Goals: `CHECK_PR`, `TEST_APP`, `LAUNCH_REVIEW`, `WEEKLY_MONITOR`, `FULL_PENTEST`, `COMPLIANCE_REVIEW`
  - Modes: `SAFE`, `QUICK`, `STANDARD`, `DEEP`, `CUSTOM`
  - With no target and no default project, pass `--auto` to detect the current git repo and create or reuse a target
  - Pass `--repo` as `owner/repo`, an HTTPS URL, or an SSH URL (e.g. `ecryptoguru/lyrashield-ai`, `https://github.com/ecryptoguru/lyrashield-ai.git`, `git@github.com:ecryptoguru/lyrashield-ai.git`)
- `pr-scan [--auto] [--repo <owner/repo>] [--mode <mode>]` — shortcut for `scan --goal CHECK_PR --mode QUICK`
- `status [scanId] [--watch]` — list scans or inspect one scan
- `targets [--name ... --type ... --url ... --repo ...]` — list or create targets
- `targets verify-domain <targetId> [--issue|--check]` — show domain-control status for a WEB_APP/API target in the configured workspace. `--issue` returns the DNS TXT host, value, and challenge expiry; publish that record, then use `--check`. Issuing replaces the previous token and verified status. The TXT value is returned only on issue; save it before exiting. All proof operations require target validation permission. Supports `--json`; invalid targets, permission failures, missing/expired proofs, and failed DNS checks exit nonzero. DNS control does not establish application security.
- `readiness [--target <targetId>]` — get the launch-readiness verdict

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
- `1` — command failed, or `gate` found findings at/above the threshold; `gate --verdict` returns NOT_READY
- `2` — usage or validation error; `gate --verdict` returns it on insufficient evidence or any error (fail-closed)
- `3` — authentication or authorization error (HTTP 401/403)
- `4` — network or other API error
- `5` — rate limited (HTTP 429)

## Global flags

- `--json` — machine-readable output (`{ ok: true/false, data|error }`)
- `--version` — print version
- `--help` / `-h` — show usage
- `NO_COLOR=1` — disable ANSI colors

## Environment

- `LYRASHIELD_API_KEY` — required; the workspace API key (`lsk_...`)
- `LYRASHIELD_API_URL` — optional; defaults to `https://app.lyrashieldai.com`
- `NO_COLOR=1` — optional; disables colored terminal output
