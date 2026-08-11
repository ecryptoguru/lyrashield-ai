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

- Upstream release/base: `v1.5.3` / `7cc9fa9faa0179fc7e35111102fe3d20a9028393`
- Fork repository: `ecryptoguru/lyrashield-engine`
- Integration model: controlled LyraShield derivative over a pinned upstream substrate; release imports require review, approval, and green CI

### Modified upstream files

- `strix/config/loader.py` — registers a pluggable product settings loader and falls back to the upstream settings class
- `strix/skills/__init__.py` — avoids creating the telemetry thread when resolved product settings disable telemetry

All product-specific behavior lives in `lyrashield/**` and `lyrashield_adapter/**`. The controlled-derivative gate permits only these two generic upstream seams and enforces a maximum `strix/**` footprint of two files, 30 insertions, and no deletions; the current delta is +24/−0. `git diff $(cat .lyrashield-upstream-base)..HEAD -- strix` and `scripts/verify-controlled-derivative.sh` are authoritative. These changes do not grant a right to use upstream trademarks.

### Added fork files

- `lyrashield_adapter/` — compatibility entry point and CLI adapter
- `.lyrashield-upstream-base`, `scripts/check-upstream.sh`, and `scripts/verify-controlled-derivative.sh` — upstream-boundary verification
- `lyrashield/` — product-owned model, budget, compaction, lifecycle, identity, evidence, and worker-contract policy
- `UPGRADES.md` and historical upstream-boundary design/plan records
- Adapter, hardening, controlled-derivative, and worker-contract regression tests

### Upstream synchronization

The workflow compares stable release trees and opens a reviewable PR when a sync is needed. Candidate code is not executed in the write-enabled preparation job. Merge requires human approval and the read-only engine CI gate; conflicts are never resolved automatically and history is never force-pushed.

Update this file whenever a new engine divergence or third-party notice is merged.

---

Apache-2.0 §6 does not grant trademark rights. All product names, logos, and brands are property of their respective owners.
