# LyraShield Engine — Notice and Changes

This product includes software developed by the following projects:

## Strix (upstream)

- Source: <https://github.com/usestrix/strix>
- License: Apache-2.0
- Usage: Forked and modified. The divergence from upstream is recorded below as required by Apache-2.0 §4(b).

## LiteLLM

- Source: <https://github.com/BerriAI/litellm>
- License: MIT
- Usage: model-client and routing dependency; LyraShield policy restricts production execution to approved GPT-5.6 deployments

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

- Upstream release/base: `v1.1.0` / `7d5a67d234bd3faef34d22be8c6f5a9607de41a3`
- Fork repository: `ecryptoguru/lyrashield-engine`
- Integration model: controlled LyraShield derivative over a pinned upstream substrate; release imports require review, approval, and green CI

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

The current derivative also carries GPT-5.6-only validation, context/output/agent/spend limits, non-interactive lifecycle hardening, deterministic report identity, structured evidence/control metadata, and worker compatibility. The file list above is representative rather than exhaustive; `git diff $(cat .lyrashield-upstream-base)..HEAD -- strix` is authoritative. These changes do not grant a right to use upstream trademarks.

### Added fork files

- `lyrashield_adapter/` — compatibility entry point and CLI adapter
- `.lyrashield-upstream-base`, `scripts/check-upstream.sh`, and `scripts/verify-thin-fork.sh` — upstream-boundary verification
- `.github/workflows/upstream-sync.yml` — daily/manual, PR-only stable-release synchronization
- `UPGRADES.md` and historical upstream-boundary design/plan records
- Adapter, hardening, and upstream-sync regression tests

### Upstream synchronization

The workflow compares stable release trees and opens a reviewable PR when a sync is needed. Candidate code is not executed in the write-enabled preparation job. Merge requires human approval and the read-only engine CI gate; conflicts are never resolved automatically and history is never force-pushed.

Update this file whenever a new engine divergence or third-party notice is merged.

---

Apache-2.0 §6 does not grant trademark rights. All product names, logos, and brands are property of their respective owners.
