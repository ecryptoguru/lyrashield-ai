# Security risk register

This is the authoritative register for accepted product and operational security risks that still require review. Acceptance records a bounded decision; it does not mean the risk is fixed or verified absent.

Owners must review each entry by its review date and record one of three outcomes in this file: mitigation with evidence, renewed acceptance with updated rationale and date, or escalation into tracked remediation. A missed review date leaves the risk open and overdue; it must not be represented as current acceptance in a release decision.

## Active accepted risks

### VERIFY-A-005 — Degraded rate limiting is per instance

- **Status:** Accepted
- **Owner:** `platform-ops`
- **Review date:** 2026-10-11
- **Affected area:** `apps/web/src/lib/rate-limit.ts`
- **Risk:** During an Upstash outage, workspace-keyed budgets apply per application instance and can therefore multiply with replica count.
- **Current bounds:** Degraded mode is logged. The in-memory store is capped at 50,000 keys with an overflow bucket, and shared enforcement resumes when Upstash is available.
- **Review action:** Confirm production alerting detects sustained Upstash absence and reassess whether the per-instance availability trade-off remains acceptable.

### VERIFY-D-005 — Engine usage is the billing meter

- **Status:** Accepted
- **Owner:** `platform-eng`
- **Review date:** 2026-10-11
- **Affected area:** `apps/worker/src/engine/output-parser.ts`
- **Risk:** The engine is the sole source of provider-usage metering, so hostile repository content that increases model activity remains inside the engine trust boundary.
- **Current bounds:** Worker-side cost caps, usage-bucket reconciliation, and unpriceable-receipt handling fail closed.
- **Review action:** Reassess the engine trust assumption and whether independent worker-side metering evidence is practical.

### VERIFY-E-008 — MCP installs trust npm version integrity

- **Status:** Accepted
- **Owner:** `platform-eng`
- **Review date:** 2026-10-11
- **Affected area:** stdio client installers for `@lyrashield/mcp@0.2.8`
- **Risk:** Installers resolve package integrity from live npm registry metadata rather than a separately stored artifact hash.
- **Current bounds:** The installer pins immutable npm version `0.2.8`; npm forbids republishing that version.
- **Review action:** Confirm the distributed version and registry guarantees remain unchanged, then reassess hash pinning or vendoring.

### VERIFY-G-001 — Compare-page disclaimers render reviewed HTML

- **Status:** Accepted
- **Owner:** `marketing-eng`
- **Review date:** 2026-10-11
- **Affected area:** `apps/marketing/src/pages/compare/[slug].astro`
- **Risk:** `set:html` would become a stored-XSS boundary if disclaimer content could enter through a CMS, generator, or any path outside reviewed commits.
- **Current bounds:** All 14 disclaimer values are plain text controlled through repository review; no non-PR authoring path exists.
- **Review action:** Confirm the authoring boundary is unchanged. Sanitize before rendering if any external or generated authoring path is introduced.

## Provenance

These four entries were accepted during the 2026-09-11 full security review. Review remediation merged through PR #660 at `ddc42df4`; the final six external evidence gates closed through PR #663 and `e9162054`. The complete historical narrative and machine ledger remain available in Git at commit `ae7cabc5` under `docs/security/review-2026-09-11.md` and `docs/security/review-2026-09-11.findings.json`.
