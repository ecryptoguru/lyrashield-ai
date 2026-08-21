# LyraShield AI documentation map

Use this index to find the owning document and avoid duplicating current truth.

## Current sources of truth

- [`../PRD.md`](../PRD.md) — product scope, release status, backlog, and founder decisions.
- [`../Phase2.md`](../Phase2.md) — verbatim archive of Phase 2 and future-roadmap material removed from the consolidated PRD; status may be historical.
- [`../codebase.md`](../codebase.md) — architecture, runtime contracts, code map, and compact implementation ledger.
- [`../AGENTS.md`](../AGENTS.md) — immediate engineering handoff, execution queue, rules, and landmines.
- [`../product.md`](../product.md) — positioning and commercial decisions.
- [`../userguide.md`](../userguide.md) — end-user workflows and limitations.
- [`../monetization.md`](../monetization.md) — approved pricing, unit economics, and affiliate terms.

## How-to guides and runbooks

- [`deployment/`](deployment/) — local setup and production deployment gates.
- [`ops/`](ops/) — desktop release/install, signing keys, RLS verification, and production smoke testing.
- [`license-key-compromise-runbook.md`](license-key-compromise-runbook.md) — signing-key incident response.

## Reference and assurance records

- [`api-stability.md`](api-stability.md) — public API compatibility policy.
- [`lite-scanner.md`](lite-scanner.md) and [`vibe-security-50.md`](vibe-security-50.md) — bounded scanner/coverage contracts.
- [`claims-readiness.md`](claims-readiness.md), [`ai-assurance-framework-mapping.md`](ai-assurance-framework-mapping.md), and [`ai-safety-test-pack.md`](ai-safety-test-pack.md) — claims and AI-assurance boundaries.
- [`release-checklists/`](release-checklists/) and [`security/`](security/) — retained evidence checklists and customer templates.

## Retained source artifacts

- [`plans/`](plans/) — approved or historically load-bearing design records. A plan is not current implementation truth.
- [`editorial/`](editorial/) — claim maps, briefs, research, and image manifests consumed by marketing validators. These are publishing inputs, not disposable notes.
- [`marketplace/`](marketplace/) — marketplace export source, licenses, validator, and reviewer artifacts. The validator runs against a generated export (which adds `manifest.json` and root plugin files), not this source directory; use `pnpm --filter @lyrashield/agent-plugin test` here.

## Retention rule

Delete a document only when it is superseded, unreferenced by code/CI/build tooling, and carries no operational, legal, security, evidence, or publication value. Mark retained historical material with provenance and direct readers to the current owner. Do not keep orphaned screenshots or generated build output in `docs/`; Git history is the recovery path.
