# LyraShield AI documentation map

Use this index to find the owning document and avoid duplicating current truth.

## Current sources of truth

- [`../PRD.md`](../PRD.md) — product scope, release status, backlog and founder decisions.
- [`../codebase.md`](../codebase.md) — architecture, runtime contracts, code map and compact implementation ledger.
- [`../AGENTS.md`](../AGENTS.md) — immediate engineering handoff, execution queue, rules and landmines.

## Compact metric, contract and evidence index

| Area                           | Owner                                                                                                                                      | Implementation or evidence locator                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product metrics                | [`growth/analytics-taxonomy.md`](./growth/analytics-taxonomy.md), [`growth/posthog-dashboard-spec.md`](./growth/posthog-dashboard-spec.md) | Metric/event definitions; producers and regression tests remain in source. This index links to the existing privacy taxonomy without duplicating it.                                                                           |
| Public and technical contracts | [`policies.md`](./policies.md), [`yellowpaper.md`](./yellowpaper.md#9-contract-version-registry)                                           | Public API compatibility policy and versioned technical contracts; executable schemas and route handlers remain authoritative.                                                                                                 |
| Workspace API keys             | [`user-guide.md`](./user-guide.md#21-settings-and-account-deletion), [`../codebase.md`](../codebase.md#5-core-contracts)                   | `packages/db/src/api-key-service.ts`, `/api/api-keys` routes and Settings UI; code/tests establish source behavior, not deployment.                                                                                            |
| Manifest integrity             | [`yellowpaper.md`](./yellowpaper.md#4-evidence-and-integrity), [`../codebase.md`](../codebase.md#5-core-contracts)                         | Worker writer and DB verifier; unit tests plus `packages/db/src/manifest-checksum.runtime.test.ts` with disposable `DATABASE_URL` and `RLS_RUNTIME_DATABASE_URL` for the same database. Null legacy inputs remain unavailable. |
| Runtime and release evidence   | [`../PRD.md`](../PRD.md#8-current-production-evidence), [`../codebase.md`](../codebase.md#11-production-topology-and-accepted-evidence)    | Dated, revision-bound deployment/runtime claims and open gates. Refresh live state before reusing a dated claim.                                                                                                               |

## Papers (public + investor safe)

Keep these three documents separate: the litepaper gives a short executive overview, the whitepaper explains the product and the yellowpaper provides technical reference. Product scope and release evidence belong to `PRD.md`; runtime and code ownership belong to `codebase.md`. The papers summarize those owners and must not establish a second release-status ledger.

- [`litepaper.md`](./litepaper.md) — executive overview of the product, differentiators, modes, coverage and business model.
- [`whitepaper.md`](./whitepaper.md) — product explanation: differentiators, audience journeys, release-loop walkthrough, eight-class failure taxonomy, scoring examples, report interpretation, commercial model, claims boundary and FAQ.
- [`yellowpaper.md`](./yellowpaper.md) — technical reference: nine execution profiles and budget ceilings, coverage/state contracts, manifest and retest integrity, fix orchestration, gate/score/identity rules, authorization, MCP catalog and client-quality parity.

## Operational documents

- [`user-guide.md`](./user-guide.md) — end-user workflows, options, permissions and limitations.
- [`webmcp-runtime.md`](./webmcp-runtime.md) — opt-in WebMCP runtime checker: commands, receipt contract, PASS/INCONCLUSIVE semantics and evidence caveats.
- [`operations.md`](./operations.md) — founder/operator runbooks: live checkout verification, license signing-key compromise response and affiliate payout operations.
- [`policies.md`](./policies.md) — public `/api/v1` stability and deprecation contract, public claims policy, accepted security-risk register and the customer threat-model worksheet.
- [`myra-spec.md`](./myra-spec.md) — master implementation specification for the Myra support agent and demo booking.

## Retained directories

- [`editorial/`](./editorial/) — claim maps, briefs, research and image manifests consumed by marketing validators.
- [`growth/`](./growth/) — analytics taxonomy, experiment ledger and PostHog dashboard spec.
- [`marketplace/`](./marketplace/) — marketplace export source, licenses, validator and reviewer artifacts.
- [`handoffs/`](./handoffs/) — dated operational context and execution queues. Refresh their source and evidence before acting; `PRD.md` §9 owns the current open gates.
- [`reviews/`](./reviews/) — dated review evidence and reproducible probe fixtures. Preserve evidence and executable fixtures referenced by operations; completed review findings belong in the current owner or Git history.

## Historical archive

- [`Phase2.md`](./Phase2.md) — Phase 2 roadmap archive: dated planning overlays (2026-08-26, 2026-09-25) plus a condensed enterprise-platform roadmap. The newest overlay records the current direction; `PRD.md` remains current truth and the verbatim original is recoverable from Git history.

## Superseded material

- `product.md`, `monetization.md`, `claims-readiness.md`, `lite-scanner.md`, `vibe-security-50.md`, `webmcp-assurance.md`, `ai-assurance-framework-mapping.md`, `ai-safety-test-pack.md`, the superseded AI-assurance release checklist and the executed simplification/billing/launch-review plans were consolidated or retired on 2026-09-12. The completed 2026-09-11 security-review files are retained in Git at `ae7cabc5`; their four continuing accepted risks remain current in [`policies.md`](./policies.md#security-risk-register). Verbatim historical content, including internal unit economics, is recoverable from Git history; `PRD.md` and `codebase.md` remain current truth. The dated `plans/` directory, dated review ledgers and `superpowers/` working artifacts were retired on 2026-09-25; executed plans are never current truth and git history is the recovery path.

## Retention rule

Delete a document only when it is superseded, unreferenced by code/CI/build tooling and carries no operational, legal, security, evidence or publication value. Mark retained historical material with provenance and direct readers to the current owner. Do not keep orphaned screenshots or generated build output in `docs/`; git history is the recovery path.
