# LyraShield Engine — CHANGES

This product includes a modified fork of [Strix](https://github.com/usestrix/strix), licensed under Apache-2.0. This record identifies the current divergence from upstream as required by Apache-2.0 §4(b).

## Baseline

- Upstream baseline: `7b639505fecf20a2d9e356f96bd91470aa828182`
- Fork repository: `ecryptoguru/lyrashield-engine`
- Integration model: thin adapter plus review-only upstream-sync PRs

## Modified upstream files

- `strix/config/loader.py`
- `strix/core/hooks.py`
- `strix/interface/main.py`
- `strix/interface/utils.py`
- `strix/report/state.py`
- `strix/runtime/docker_client.py`
- `strix/telemetry/logging.py`
- `pyproject.toml` and `uv.lock`
- Existing tests under `tests/`

These changes support the LyraShield adapter contract, telemetry defaults, output compatibility, sandbox hardening, and regression coverage. They do not grant a right to use upstream or LyraSec trademarks.

## Added fork files

- `lyrashield_adapter/` — compatibility entry point and CLI adapter
- `.lyrashield-upstream-base`, `scripts/check-upstream.sh`, and `scripts/verify-thin-fork.sh` — upstream-boundary verification
- `.github/workflows/upstream-sync.yml` — weekly/manual, PR-only upstream synchronization
- `UPGRADES.md` and the thin-fork design/plan records
- Adapter, hardening, and upstream-sync regression tests

## Upstream synchronization

The workflow verifies ancestry, aborts rewritten history, and opens a reviewable PR when a sync is needed. It does not auto-merge, force-push, resolve conflicts, or run mechanical repository-wide renames.

Update this file whenever a new engine divergence is merged. `engine-NOTICE.md` contains the required third-party notices.
