# LyraShield CLI

The `lyrashield` command-line interface installs, configures, and drives LyraShield scans from a terminal or CI pipeline.

## Quick start

```sh
npx lyrashield login              # paste an API key when prompted
npx lyrashield use <workspace>
```

You can also set `LYRASHIELD_API_KEY` (and optionally `LYRASHIELD_API_URL`) in the environment. `LYRASHIELD_API_URL` defaults to `https://app.lyrashieldai.com`.

## Usage

```sh
lyrashield <command> [args] [--json]
```

## Commands

### Authentication and setup

- `login` — store an API key locally (`~/.lyrashield/credentials.json` with `0o600` permissions)
- `logout` — remove stored credentials
- `use <workspace>` — set the default workspace for subsequent commands
- `doctor` — diagnose credentials, API reachability, and locally detected agents

### Agent installation

- `init` — detect and configure all installed agents
- `install <agent> [--transport stdio|remote-http] [--global|--project] [--inline-secret] [--dry-run]` — add LyraShield to a single agent's config
- `uninstall <agent>` — remove the LyraShield entry from a single agent's config
- `rules add <agent>|remove <agent>|check` — add, remove, or validate an agent rules file (`AGENTS.md`, `CLAUDE.md`, etc.)

`install` refuses to write raw secrets into shared-by-convention files unless you pass `--inline-secret` and the file is gitignored. Use `--dry-run` to preview the config change without writing it.

### Targets and scans

- `scan --target <targetId> [--goal <goal>] [--mode <mode>]` — start a scan
  - Goals: `CHECK_PR`, `TEST_APP`, `LAUNCH_REVIEW`, `WEEKLY_MONITOR`, `FULL_PENTEST`, `COMPLIANCE_REVIEW`
  - Modes: `SAFE`, `QUICK`, `STANDARD`, `DEEP`, `CUSTOM`
- `status [scanId] [--watch]` — list scans or inspect one scan
- `targets [--name ... --type ... --url ... --repo ...]` — list or create targets
- `readiness [--target <targetId>]` — get the launch-readiness verdict

### Findings and fixes

- `findings [--severity ...] [--status ...] [--target ...] [--scan ...] [--verified ...] [--stats]` — list findings
- `explain <findingId>` — show full finding detail and plain-language guidance
- `fix-plan <findingId>` — **read-only** remediation plan assembled from the finding's verified detail
- `fix-plan create <findingId> --summary <summary>` — record a fix proposal on a finding (summary must be ≥ 10 characters)
- `verify <findingId>` — queue a retest of a finding

### Local checks and CI

- `check-diff [--staged] [--base <ref>] [--head <ref>] [--sarif <file>]` — fast advisory diff check for obvious risky patterns; not a substitute for a verified scan
- `gate [--fail-on HIGH|MEDIUM|LOW] [--staged] [--base <ref>] [--head <ref>] [--sarif <file>]` — combine local diff patterns with open findings and fail at the chosen severity threshold

### Reports and approvals

- `report [--title ... --scan <scanId> --type executive|developer|compliance]` — list or create reports
- `approvals list|create <actionName>|approve <approvalId>|deny <approvalId>` — manage agent-approval requests
- `mcp call <tool> [--input '{...}']` — call a remote MCP tool
- `hook install` — install a pre-commit hook that runs `lyrashield check-diff`

## Exit codes

- `0` — success
- `1` — command failed, or `gate` found findings at/above the threshold
- `2` — usage or validation error
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
