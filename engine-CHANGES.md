# LyraShield Engine — CHANGES

This file lists modifications made to the upstream Strix project (https://github.com/usestrix/strix)
as required by the Apache License 2.0, Section 4(b).

## Modified Files

<!-- List each file that has been modified from upstream Strix. -->
<!-- Example entries: -->

- `strix/__main__.py` — Rebranded CLI entry point, changed default config paths
- `strix/config.py` — Added LyraShield-specific configuration options
- `strix/agents/agent.py` — Added budget guard hooks, output normalization
- `README.md` — Replaced with LyraShield-specific documentation

## Added Files

<!-- List new files added that did not exist in upstream. -->

- `lyrashield_wrapper.py` — Thin wrapper for output normalization and branding
- `requirements-lyrashield.txt` — Additional Python dependencies

## Removed Files

<!-- List files removed from upstream. -->

- (none)

---

## Fork Strategy

Per PRD §B9, the fork strategy is to keep the vendored engine as close to pristine
upstream as possible. Brand and normalize output in the TypeScript worker layer,
not in the engine itself. This minimizes monthly merge-conflict debt.

A "files we've diverged in" manifest should be maintained alongside this file
and updated whenever a new divergence is introduced.

A CVE-/security-triggered fast-path merge should be maintained separately from
the routine monthly feature sync.
