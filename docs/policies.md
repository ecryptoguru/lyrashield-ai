# Policies

Consolidated policy documents: the public API contract, the public claims boundary, the accepted security-risk register and the customer threat-model worksheet.

## API stability policy

### `/api/v1` — additive-only

The `/api/v1` surface is **additive-only**. We will not remove fields, rename paths, change the meaning of status codes or narrow the set of allowed request shapes in a v1 route.

- New fields may be added to existing response envelopes.
- New query parameters, headers and optional request-body fields may be added.
- New v1 routes may be introduced.
- Existing routes may return additional non-breaking status codes.

#### Additive surface (current)

The following routes are part of the additive-only surface and will not be removed or have their request shape narrowed without a version bump:

- `/api/licenses/activate` — POST, activate a machine against a Local license
- `/api/licenses/verify` — POST, verify license signature and check revocation
- `/api/licenses/issue` — POST, issue a signed license (admin/server-side)
- `/api/sync/connect` — POST, link Local license to workspace for cloud sync
- `/api/sync/findings` — POST, sync findings from desktop to cloud workspace
- `/affiliates/api/apply` — POST, affiliate application
- `/affiliates/api/click` — POST, click tracking
- `/affiliates/api/links` — GET/POST, link management
- `/affiliates/api/payouts/request` — POST, payout request
- `/affiliates/api/payouts/method` — POST, payout method update
- `/billing/checkout` — POST, create checkout session (Polar/Razorpay)
- `/billing/webhook` — POST, webhook endpoint (Polar/Razorpay)
- `/billing/portal` — GET, customer portal URL
- `/api/gate/[targetId]` — GET/POST, read the persisted Launch Gate verdict (GET) or re-evaluate it (POST)
- `/api/reports/launch-readiness` — POST, generate a signed Launch Readiness Report
- `/api/reports/verify` — POST, verify a Launch Readiness Report signature by checksum
- `/api/taxonomy/ai-built-failures` — GET, public versioned AI-Built Failure Taxonomy reference
- `/api/badge/readiness/[reportId]` — GET, README badge reflecting a target's Launch Gate verdict (token-gated)

Any change that would cause a correctly written v1 client to break must ship as `/api/v2`.

### Breaking changes require a new version

A breaking change is one that would:

- Remove or rename an existing v1 path or HTTP method.
- Remove a field from a response or make a previously optional field required.
- Change the type, format or meaning of an existing field.
- Remove a previously returned status code or change its semantics.
- Tighten validation in a way that rejects previously valid requests.

When a breaking change is needed, it is introduced under a new `/api/v2` prefix. The previous `/api/v1` route remains available for a deprecation window.

### Deprecation window

A v1 endpoint, field or status code may be deprecated, but it will not be removed without:

- A minimum **90-day notice** from the date the deprecation is published.
- Documentation in the OpenAPI spec (`/api/v1/openapi.json`) with `deprecated: true`.
- A changelog entry in this file and release notes.
- A migration path documented for integrators.

After the 90-day window, the deprecated surface may be removed from v1. If removal would break clients, it is preserved and a v2 alternative is provided instead.

### Client-side path normalization changelog

The public `/api/v1` URL surface is unchanged. Client-side changes that do not affect the wire contract are recorded here for integrators and operators:

- **2026-07-31 — CLI and MCP path normalization:** The CLI and MCP server now pass bare API paths (e.g., `/findings`) to the `@lyrashield/sdk` client, which continues to prepend `/api/v1` in `buildUrl()`. This fixes an earlier double-prefix bug where some tool calls produced `/api/v1/v1/...` paths. Existing v1 route URLs remain valid.
- **2026-08-01 — OpenAPI builder packaged:** The OpenAPI 3.1 spec builder moved from `apps/web/src/lib/openapi/` to a declared `@lyrashield/types/openapi` export. The generated `/api/v1/openapi.json` response and the marketing build that consumes the same spec are unchanged; only the internal package boundary moved.

### No migrations in the API contract

Breaking API changes are handled by versioning, not by data migrations or automatic redirects. Clients choose the version they call.

## Public claims policy

> **Owner:** Founder, with engineering, security and legal review
>
> **Review cadence:** Quarterly and before any release that changes a public assurance, security, privacy, compliance, certification, benchmark or guarantee claim

This policy governs public product, marketing, investor, marketplace and sales claims. Product behavior and evidence boundaries live in `PRD.md`, `AGENTS.md` and the public papers; this section owns the review obligation.

### Current boundary

Claims must name their scope, evidence, date or version where relevant and material limitations. LyraShield AI may describe itself as evidence-backed release assurance for AI-built software. It must not claim certification, compliance, guaranteed security, universal detection, unnamed AI safety testing or proven adversarial robustness without the external attestation, reproducible evaluation, formal certificate or bounded contractual basis required for that exact claim.

First-party evaluation results must remain labeled first-party and tied to the named corpus, method and result. They must not be described as independent review. A clean or completed scan must not be presented as universal security proof.

### Required controls

- A human reviewer must approve copy before every indexable marketing deployment.
- CI should reject newly introduced positive claim patterns such as `is certified`, `is compliant`, `SOC 2 certified`, `ISO 27001 certified`, `guarantees security`, `universal security`, unnamed `AI safety tested` and `adversarial robustness proven`. Negative disclosures and policy text need an explicit reviewed allowance.
- The owner must review this policy quarterly and before any claim-changing release. Record the review date and resulting changes in the pull request that updates this file.
- Claims of external certification or compliance require the issued attestation or certificate for the stated scope and period.
- Claims of measured detection or evaluation require a reproducible corpus, versioned method, published bounded result and clear first-party or independent-review status.
- Any guarantee-shaped claim requires counsel-approved scope, prerequisites, remedy and liability terms, plus applicable insurance review.

### Open evidence obligations

- The published 2026-08-13 OWASP result and AILuminate demo observation remain first-party evidence. Independent review is required before using independent-review language.
- The removed historical evaluation runner must be restored or replaced before claiming clean-checkout reproducibility for those results.
- SOC 2, ISO 27001, ISO 42001 and similar claims remain unavailable until the relevant external process is complete and its exact scope can be cited.

### Primary references

- [AICPA SOC 2 and assurance resources](https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2)
- [NIST ARIA](https://ai-challenges.nist.gov/aria)
- [NIST AI 100-2e2025](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-2e2025.pdf)
- [MLCommons AILuminate](https://mlcommons.org/benchmarks/ailuminate/)
- [OWASP GenAI Red Teaming and Evaluation](https://genai.owasp.org/initiative/red-teaming-evaluation/)

Historical legal analysis, proposed certification roadmaps, cost estimates and the complete reference list remain in Git at commit `e3fa791f` under `docs/claims-readiness.md`. Revalidate external requirements and obtain qualified legal advice before relying on them.

## Security risk register

This is the authoritative register for accepted product and operational security risks that still require review. Acceptance records a bounded decision; it does not mean the risk is fixed or verified absent.

Owners must review each entry by its review date and record one of three outcomes in this file: mitigation with evidence, renewed acceptance with updated rationale and date or escalation into tracked remediation. A missed review date leaves the risk open and overdue; it must not be represented as current acceptance in a release decision.

### Active accepted risks

#### VERIFY-A-005 — Degraded rate limiting is per instance

- **Status:** Accepted
- **Owner:** `platform-ops`
- **Review date:** 2026-10-11
- **Affected area:** `apps/web/src/lib/rate-limit.ts`
- **Risk:** During an Upstash outage, workspace-keyed budgets apply per application instance and can therefore multiply with replica count.
- **Current bounds:** Degraded mode is logged. The in-memory store is capped at 50,000 keys with an overflow bucket and shared enforcement resumes when Upstash is available.
- **Review action:** Confirm production alerting detects sustained Upstash absence and reassess whether the per-instance availability trade-off remains acceptable.

#### VERIFY-D-005 — Engine usage is the billing meter

- **Status:** Accepted
- **Owner:** `platform-eng`
- **Review date:** 2026-10-11
- **Affected area:** `apps/worker/src/engine/output-parser.ts`
- **Risk:** The engine is the sole source of provider-usage metering, so hostile repository content that increases model activity remains inside the engine trust boundary.
- **Current bounds:** Worker-side cost caps, usage-bucket reconciliation and unpriceable-receipt handling fail closed.
- **Review action:** Reassess the engine trust assumption and whether independent worker-side metering evidence is practical.

#### VERIFY-E-008 — MCP installs trust npm version integrity

- **Status:** Accepted
- **Owner:** `platform-eng`
- **Review date:** 2026-10-11
- **Affected area:** stdio client installers for `@lyrashield/mcp@0.2.9`
- **Risk:** Installers resolve package integrity from live npm registry metadata rather than a separately stored artifact hash.
- **Current bounds:** The installer pins immutable npm version `0.2.9`; npm forbids republishing that version.
- **Review action:** Confirm the distributed version and registry guarantees remain unchanged, then reassess hash pinning or vendoring.

#### VERIFY-G-001 — Compare-page disclaimers render reviewed HTML

- **Status:** Accepted
- **Owner:** `marketing-eng`
- **Review date:** 2026-10-11
- **Affected area:** `apps/marketing/src/pages/compare/[slug].astro`
- **Risk:** `set:html` would become a stored-XSS boundary if disclaimer content could enter through a CMS, generator or any path outside reviewed commits.
- **Current bounds:** All 13 disclaimer values are plain text controlled through repository review; no non-PR authoring path exists.
- **Review action:** Confirm the authoring boundary is unchanged. Sanitize before rendering if any external or generated authoring path is introduced.

### Risk register provenance

These four entries were accepted during the 2026-09-11 full security review. Review remediation merged through PR #660 at `ddc42df4`; the final six external evidence gates closed through PR #663 and `e9162054`. The complete historical narrative and machine ledger remain available in Git at commit `ae7cabc5` under `docs/security/review-2026-09-11.md` and `docs/security/review-2026-09-11.findings.json`.

## Customer-declared AI system threat model

Use this template to prepare the facts entered in the private target workspace. It is an inventory and review aid, not a verification, certification or security guarantee.

### Scope and owner

- System purpose and model/provider/deployment:
- Accountable owner:
- Review date:
- Known limits and excluded environments:

### Assets and data flows

- Assets and sensitivity:
- RAG or other data sources:
- Storage/vector systems and retention:
- Tools/actions and MCP integrations:
- Human oversight and approval points:

### Trust boundaries

For each boundary, state what crosses it, who controls each side and the authentication/authorization decision.

### Threat scenarios

For each scenario record a title, severity, description, mitigation, test plan, owner and review date. High and critical scenarios require all three of mitigation, test plan and owner before an immutable version can be created.

### Review record

- Version/checksum:
- Customer-declared by:
- Date:
- Changes since prior version:
