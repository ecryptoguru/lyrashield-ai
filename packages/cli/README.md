# LyraShield CLI

The `lyrashield` command-line interface.

## Usage

```sh
npx lyrashield <command> [args]
```

## Commands

- `login` — store an API key
- `logout` — remove stored credentials
- `use <workspace>` — set default workspace
- `agents` — list registry agents and detection state
- `doctor` — diagnose configuration and API reachability
- `init` — detect and configure installed agents
- `install <agent>` / `uninstall <agent>` — configure a single agent
- `scan` — start a scan
- `status [scanId]` — scan status
- `findings` — list findings
- `explain <findingId>` / `fix-plan <findingId>` / `verify <findingId>`
- `check-diff` — local advisory diff check
- `gate` — CI gate (local + findings)
- `report`, `readiness`, `targets`
- `rules add <agent>` — stub for PR2

## Exit codes

- `0` — ok
- `1` — findings at/above threshold (`gate`) or command failed
- `2` — usage error
- `3` — auth error
- `4` — network/API error
- `5` — rate limited

## Global flags

- `--json` — machine-readable output
- `--version` — print version
- `--help` — show usage
- `NO_COLOR=1` — disable colors
