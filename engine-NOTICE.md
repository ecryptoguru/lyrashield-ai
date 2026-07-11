# LyraShield Engine — Notice and Changes

This product includes software developed by the following projects:

## Strix (upstream)

- Source: <https://github.com/usestrix/strix>
- License: Apache-2.0
- Usage: Forked and modified. The divergence from upstream is recorded below as required by Apache-2.0 §4(b).

## LiteLLM

- Source: <https://github.com/BerriAI/litellm>
- License: MIT
- Usage: LLM provider abstraction layer (dependency)

## Caido

- Source: <https://github.com/caido/caido>
- License: MIT
- Usage: HTTP proxy and request interception (dependency)

## OpenAI Agents SDK

- Source: <https://github.com/openai/openai-agents-python>
- License: MIT
- Usage: Agent framework (dependency)

## Textual

- Source: <https://github.com/Textualize/textual>
- License: MIT
- Usage: Terminal UI framework (dependency)

## Changes from Strix

### Baseline

- Upstream baseline: `7b639505fecf20a2d9e356f96bd91470aa828182`
- Fork repository: `ecryptoguru/lyrashield-engine`
- Integration model: thin adapter plus review-only upstream-sync PRs

### Modified upstream files

- `strix/config/loader.py`
- `strix/config/settings.py` — added Azure AI env aliases (`AZURE_AI_API_KEY`, `AZURE_AI_API_BASE`) and `LLM_API_VERSION` support
- `strix/config/models.py` — mirrors Azure / Azure AI config into LiteLLM env vars; avoids `OPENAI_BASE_URL` for Azure providers
- `strix/core/hooks.py`
- `strix/interface/main.py`
- `strix/interface/utils.py`
- `strix/report/state.py`
- `strix/runtime/docker_client.py`
- `strix/telemetry/logging.py`
- `pyproject.toml` and `uv.lock`
- Existing tests under `tests/`

These changes support the LyraShield adapter contract, telemetry defaults, output compatibility, sandbox hardening, and regression coverage. They do not grant a right to use upstream or LyraSec trademarks.

### Added fork files

- `lyrashield_adapter/` — compatibility entry point and CLI adapter
- `.lyrashield-upstream-base`, `scripts/check-upstream.sh`, and `scripts/verify-thin-fork.sh` — upstream-boundary verification
- `.github/workflows/upstream-sync.yml` — weekly/manual, PR-only upstream synchronization
- `UPGRADES.md` and the thin-fork design/plan records
- Adapter, hardening, and upstream-sync regression tests

### Upstream synchronization

The workflow verifies ancestry, aborts rewritten history, and opens a reviewable PR when a sync is needed. It does not auto-merge, force-push, resolve conflicts, or run mechanical repository-wide renames.

Update this file whenever a new engine divergence or third-party notice is merged.

---

LyraShield is a trademark of LyraSec. Apache-2.0 §6 does not grant trademark rights.
All product names, logos, and brands are property of their respective owners.
