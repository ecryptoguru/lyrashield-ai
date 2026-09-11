# LyraShield AI documentation map

Use this index to find the owning document and avoid duplicating current truth.

## Current sources of truth

- [`../PRD.md`](../PRD.md) — product scope, release status, backlog, and founder decisions.
- [`../codebase.md`](../codebase.md) — architecture, runtime contracts, code map, and compact implementation ledger.
- [`../AGENTS.md`](../AGENTS.md) — immediate engineering handoff, execution queue, rules, and landmines.

## Papers (public + investor safe)

- [`litepaper.md`](./litepaper.md) — executive overview of the product, modes, coverage, and business model.
- [`whitepaper.md`](./whitepaper.md) — authoritative public description: problem, product, evidence model, assurance features, commercial model, claims boundary, roadmap.
- [`yellowpaper.md`](./yellowpaper.md) — technical specification: architecture, scan pipeline, coverage contracts, evidence integrity, tenancy, distribution contracts.

## Operational documents

- [`user-guide.md`](./user-guide.md) — end-user workflows, options, permissions, and limitations.
- [`api-stability.md`](./api-stability.md) — public `/api/v1` compatibility and deprecation policy.
- [`license-key-compromise-runbook.md`](./license-key-compromise-runbook.md) — signing-key incident response.

## Retained directories

- [`security/`](./security/) — committed security-review evidence and the threat-model template.
- [`release-checklists/`](./release-checklists/) — retained evidence checklists.
- [`plans/`](./plans/) — live implementation briefs awaiting dispatch only; a plan is never current implementation truth. Executed plans are removed once absorbed or obsolete; git history is the recovery path.
- [`editorial/`](./editorial/) — claim maps, briefs, research, and image manifests consumed by marketing validators.
- [`marketplace/`](./marketplace/) — marketplace export source, licenses, validator, and reviewer artifacts.

## Superseded material

- `Phase2.md`, `product.md`, `monetization.md`, `claims-readiness.md`, `lite-scanner.md`, `vibe-security-50.md`, `webmcp-assurance.md`, `ai-assurance-framework-mapping.md`, `ai-safety-test-pack.md`, and the executed simplification/billing/launch-review plans were consolidated into the three papers above on 2026-09-12. Their verbatim content — including the Phase 2 archive and internal unit economics — is recoverable from git history; `PRD.md` and `codebase.md` remain current truth.

## Retention rule

Delete a document only when it is superseded, unreferenced by code/CI/build tooling, and carries no operational, legal, security, evidence, or publication value. Mark retained historical material with provenance and direct readers to the current owner. Do not keep orphaned screenshots or generated build output in `docs/`; git history is the recovery path.
