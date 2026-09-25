# LyraShield AI documentation map

Use this index to find the owning document and avoid duplicating current truth.

## Current sources of truth

- [`../PRD.md`](../PRD.md) — product scope, release status, backlog and founder decisions.
- [`../codebase.md`](../codebase.md) — architecture, runtime contracts, code map and compact implementation ledger.
- [`../AGENTS.md`](../AGENTS.md) — immediate engineering handoff, execution queue, rules and landmines.

## Papers (public + investor safe)

- [`litepaper.md`](./litepaper.md) — executive overview of the product, modes, coverage and business model.
- [`whitepaper.md`](./whitepaper.md) — authoritative public description: problem, product, evidence model, assurance features, commercial model, claims boundary, roadmap.
- [`yellowpaper.md`](./yellowpaper.md) — technical specification: architecture, scan pipeline, coverage contracts, evidence integrity, tenancy, distribution contracts.

## Operational documents

- [`user-guide.md`](./user-guide.md) — end-user workflows, options, permissions and limitations.
- [`operations.md`](./operations.md) — founder/operator runbooks: live checkout verification, license signing-key compromise response, trial claim backfill and affiliate payout operations.
- [`policies.md`](./policies.md) — public `/api/v1` stability and deprecation contract, public claims policy, accepted security-risk register and the customer threat-model worksheet.
- [`myra-spec.md`](./myra-spec.md) — master implementation specification for the Myra support agent and demo booking.

## Retained directories

- [`editorial/`](./editorial/) — claim maps, briefs, research and image manifests consumed by marketing validators.
- [`growth/`](./growth/) — analytics taxonomy, experiment ledger and PostHog dashboard spec.
- [`marketplace/`](./marketplace/) — marketplace export source, licenses, validator and reviewer artifacts.

## Superseded material

- `Phase2.md`, `product.md`, `monetization.md`, `claims-readiness.md`, `lite-scanner.md`, `vibe-security-50.md`, `webmcp-assurance.md`, `ai-assurance-framework-mapping.md`, `ai-safety-test-pack.md`, the superseded AI-assurance release checklist and the executed simplification/billing/launch-review plans were consolidated or retired on 2026-09-12. The completed 2026-09-11 security-review files are retained in Git at `ae7cabc5`; their four continuing accepted risks remain current in [`policies.md`](./policies.md#security-risk-register). Verbatim historical content, including the Phase 2 archive and internal unit economics, is recoverable from Git history; `PRD.md` and `codebase.md` remain current truth. The dated `plans/` directory, dated review ledgers and `superpowers/` working artifacts were retired on 2026-09-25; executed plans are never current truth and git history is the recovery path.

## Retention rule

Delete a document only when it is superseded, unreferenced by code/CI/build tooling and carries no operational, legal, security, evidence or publication value. Mark retained historical material with provenance and direct readers to the current owner. Do not keep orphaned screenshots or generated build output in `docs/`; git history is the recovery path.
