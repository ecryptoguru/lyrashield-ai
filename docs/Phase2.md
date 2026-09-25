# LyraShield AI — Phase 2 Roadmap and Future Archive

> Curated and condensed on 2026-09-25. This file began as a verbatim extraction from `PRD.md` (commit `69a72afc`, immediately before the 2026-08-21 consolidation). Completed audit and remediation records, implementation history and status tables were removed in this condensation — `codebase.md` owns implementation history, `PRD.md` and `AGENTS.md` own current truth, and the untouched verbatim original remains recoverable in Git history (`10ec5f25^`, also `ae7cabc5`).

## Planning overlay — 2026-09-25

This overlay records the current Phase 2 direction as of 2026-09-25 and supersedes the 2026-08-26 overlay below, which is retained in condensed form, as is the archive beneath it. `PRD.md`, `AGENTS.md`, `docs/whitepaper.md` §10 and running code remain authoritative for current implementation and release status.

### What changed since the 2026-08-26 overlay

- The product remains in open beta with open registration; both Polar and Razorpay Cloud purchase admissions read back `public` on 2026-09-14, with both Local admissions `off`.
- The two-line commercial schedule was published 2026-09-22 (Starter/Pro scan line plus Agency/Enterprise line; former Launch Assurance plan ID retained for billing compatibility).
- Phase 2 preconditions are unchanged: the launch gates below are still open and no design-partner interview evidence has been retained.

### Launch gates still open before Phase 2 (per `PRD.md` §9)

1. Merge and deploy the scorecard canonical-origin fix, then repeat live canonical/OG readback.
2. Retain longer-window Redis command/capacity evidence; provision RazorpayX and Payoneer payout API access plus the tax-form workflow.
3. Triage the 25 findings from the accepted Standard scan and obtain independent verification where warranted.
4. Select and authorize a controlled Deep/Terra target, then retain separate routing, cost, receipt, image, and terminal-state evidence.
5. Capture authenticated client-matrix receipts plus webmaster indexing and answer-engine citation observations.

### Current Phase 2 direction (aligned with `docs/whitepaper.md` §10)

Phase 2 (enterprise governance) proceeds only after the launch gates close and design-partner interviews validate demand:

- **Pilot wedge:** OIDC enterprise sign-in, role-management over the existing permission model, workspace policy enforcement, an outbound-only private worker, audit export and evidence retention — proven with 2–3 design partners.
- **Productized demand:** SCIM, SAML where demanded, customer-managed evidence storage and keys, retention/deletion controls, evidence-backed compliance mappings (no certification claim), data residency where contracted.
- **Requested integrations:** one generic signed outbound webhook preferred over many narrow adapters; SIEM, Jira/Linear, release gates, CI/CD and identity directories as named customers require.
- **Expansion branch (choose one):** customer VPC, self-hosting, MSP/MSSP operations or deeper scanner coverage — selected on validated demand.

### Explicitly deferred

Security Copilot sidebar and visual security plans/recaps; compliance-lite evidence packs; IaC, container, cloud-account and reachability scanning; local/self-hosted model support; a human-validated pentest add-on; a broad ASPM/attack-path platform; and a large speculative integration catalog.

## Planning overlay — 2026-08-26 (condensed)

Record of the Phase 2 direction at that date:

- **Product direction:** initial enterprise segment of regulated SaaS and fintech teams; LyraShield SaaS control plane with an outbound-only customer private worker; a 2–3 design-partner pilot (90-day build, 30-day pilot) whose success is governance proof plus basic evidence retention/export around the existing loop; public-market research is directional input only, not customer validation.
- **Prerequisites:** close the current launch gates (status tracked in `PRD.md`/`AGENTS.md`, not duplicated here); interview 2–3 design partners and retain a decision log covering finding overload, proof that a fix worked, approval fatigue, private data flow, audit evidence and non-human identity controls; confirm segment, private-worker boundary, procurement requirements, retention/export needs and pilot success criteria before committing the wider roadmap.
- **Months 1–3, pilot wedge:** OIDC enterprise sign-in; SAML only when a signed design partner requires it; enterprise role-management UI over the existing permission model (no second authorization system); workspace policy enforcement; outbound-only private worker; audit export and evidence retention.
- **Months 4–6, productize validated demand:** SCIM lifecycle management; SAML where confirmed by demand; customer-managed evidence storage and KMS/Vault keys; retention and deletion controls with fail-closed evidence semantics; evidence-backed compliance mappings and export packs (no certification claim); data-residency controls where contractually required; full contextual prioritization using repository reachability and customer-owned business context, with provenance and explicit uncertainty.
- **Months 7–9, requested integrations only:** implement only what active design partners or paying customers request; prefer one generic signed outbound webhook before maintaining many narrow adapters; likely candidates are SIEM, Jira/Linear, GitHub/GitLab release gates, CI/CD and cloud identity directories.
- **Months 10–12, choose one expansion branch:** customer VPC deployment, Helm/self-hosted deployment, MSP/MSSP multi-tenant operations, or deeper scanner coverage — never all four in parallel.
- **Pain signals shaping this split:** finding volume without business or reachability context creates triage work rather than decisions; teams need exact server-owned evidence that a fix was retested against the intended revision; risk-tiered approvals are more usable than per-action prompts; enterprise buyers need an exact data-flow and private-processing boundary, not a generic "private" claim; audit evidence must be operationally exportable and attributable to both human and non-human actors.

## Historical archive (condensed 2026-09-25)

### Phases and differentiation

- Phase 1 (vibe coders, solopreneurs, startups, agencies, small teams) hides complexity; Phase 2 (enterprise, regulated teams, large engineering orgs, security teams) adds governance, policy, deployment and compliance controls without breaking the simple workflow. The core Target → Scan → Evidence State → Fix Proposal → Retest → Report loop stays identical for both phases.
- Durable differentiators: explicit evidence states over inflated verification claims; plain-language explanations alongside technical evidence; fix proposals with server-owned retests and assurance reports; sandboxed execution; one-click onboarding; enterprise governance later rather than upfront; BYOK/BYOM and private-worker deployment in Phase 2; human-validated pentest add-on later.

### Target users and jobs

Primary users: AppSec teams, CISOs, security and platform engineering teams, regulated SaaS companies, fintech, healthcare, large engineering orgs, MSPs and MSSPs.

- **Govern scans across all teams** — who can scan, what can be scanned, when production can be scanned, what blocks release, who can accept risk, where evidence is stored.
- **Use private deployment** — private repos, internal apps, staging environments, private APIs, cloud infrastructure.
- **Generate compliance evidence** — SOC 2 and ISO 27001-style evidence, OWASP Top 10 and CWE mapping, accepted-risk register, retest attestation, audit logs.
- **Integrate with enterprise workflows** — GitHub Enterprise, GitLab self-managed, Azure DevOps, Jira, ServiceNow, Slack/Teams, SIEM export (Splunk, Datadog, Sentinel).

### Phase 2 feature scope

- **Must-have:** SAML and OIDC SSO, SCIM provisioning, advanced RBAC, policy engine, production scan approval, audit logs, evidence retention controls, BYOK, BYOM, private worker, VPC deployment, self-hosted Helm deployment, enterprise integrations (GitHub Enterprise, GitLab self-managed, Azure DevOps, Jira, Slack, Microsoft Teams, ServiceNow), compliance reports, SIEM export, admin dashboard.
- **Should-have:** cloud-account, IaC and container scanning dashboards, ASPM-style risk graph, data-residency controls, private evidence storage, human-validated pentest add-on, MSP multi-client console. GraphQL for enterprise dashboards and richer event streaming are optional extensions.
- **Enterprise success metrics:** pilot activation, SSO and private-worker setup completion, protected targets, policy adoption, audit export usage, compliance report generation, MTTR reduction, renewal intent, expansion revenue.
- **Packaging sketch:** Business (advanced teams, policies, Jira/Teams, audit logs, compliance report basics); Enterprise SaaS (SSO, SCIM, advanced RBAC, audit exports, compliance packs, SIEM export, support SLA); Enterprise Private (VPC deployment, private workers, BYOK, BYOM, private storage, custom retention); Self-Hosted (Helm chart, license key, offline-friendly option, support contract, upgrade support).
- **Navigation additions:** Policies, Compliance, Audit Logs, Identity, Private Workers, Admin, Deployments.

### Enterprise platform sprints (not started)

Each sprint is 1–2 weeks unless noted; goals and acceptance essence only — full task lists remain in Git history.

- **Sprint 12 — Enterprise identity:** SAML/OIDC SSO, domain verification, enterprise auth settings, SSO audit logs, optional 2FA/passkey policy, IdP metadata storage. Accepted when an enterprise workspace can enable SSO, domain verification works, SSO changes are audited and fallback owner access is defined.
- **Sprint 13 — SCIM and advanced RBAC:** SCIM user lifecycle, IdP user/group mapping, advanced roles (ORG_OWNER, SECURITY_ADMIN, APPSEC_MANAGER, DEVELOPER, AUDITOR, BILLING_ADMIN, READ_ONLY, EXTERNAL_PENTESTER), permission matrix, RBAC middleware, members UI, role-change audit logs.
- **Sprint 14 — Policy engine:** policy editor and evaluation service controlling production scan approval, scan windows, blocked paths, allowed domains, max budget/duration, rate limits, evidence retention and destructive-action controls; policy changes are audited.
- **Sprint 15 — Audit logs and compliance reports:** audit viewer with filters and CSV/JSON export; report templates for SOC 2, ISO 27001, OWASP Top 10, CWE, accepted-risk register, retest attestation and remediation SLA.
- **Sprint 16 — Private worker (2 weeks):** worker registration, tokens, heartbeat, job-pull model, workspace-level worker selection, admin UI and docs. Accepted when a scan runs through a private worker and the SaaS control plane needs no direct access to the private target.
- **Sprint 17 — Enterprise integrations (2 weeks):** GitHub Enterprise, GitLab self-managed, Azure DevOps, Microsoft Teams, Jira advanced fields, ServiceNow, Splunk/Datadog/Sentinel webhooks, with audited integration events.
- **Sprint 18 — BYOK, BYOM and data controls:** LLM provider config with vault-held secret references, model routing policy, retention and evidence-storage settings, PII redaction, data export/delete workflows.
- **Sprint 19 — VPC and self-hosted deployment (2–4 weeks):** production Docker images, Helm chart, Terraform module (Azure; AWS optional), license-key service, external secret support, backup/restore, upgrade docs and observability stack.

**Phase 2 deployment shape:** Kubernetes job per scan with dedicated worker node pools and network policies; customer private worker / VPC connector running LyraShield sandbox jobs against customer-approved LLM providers; customer-owned storage and KMS. There is no separate `apps/api` — Next.js route handlers in `apps/web` remain the product API.

### Agent-era sprints (record)

- **Sprint 3.5 / 7.5 — agent action and approval layers: complete (2026-07-06).** Typed agent actions behind the existing permission bridge; single-use exact-input approvals with audit logs. See `codebase.md`.
- **Sprint 9.5 — MCP server for coding agents: core complete.** `@lyrashield/mcp` stdio plus the remote Streamable HTTP endpoint, read-only defaults, installer automation and per-agent setup docs. Broader client onboarding and tool coverage remain roadmap work.
- **Sprint 5.5 (Security Copilot sidebar) and Sprint 8.5 (visual security plan and recap): not started; deferred.**

### Key decisions

- The agent layer calls LyraShield APIs, never the product database directly; it owns only agent runtime state; keep the action surface small (10–15 core actions); reads run freely, mutations require permission, high-impact actions require approval.
- MCP is an OAuth 2.1 resource server: PKCE, audience binding, dynamic client registration, token exchange for internal calls (never pass the caller's token through — confused-deputy defense); `needsApproval` on every mutating/destructive tool, bound to the exact input and re-validated at execution.
- Scan egress always traverses the validated, DNS-pinned proxy; per-scan sandboxes stay bounded, non-root and deny-by-default.

### Key risks

1. **ORM ownership mismatch** — Prisma remains the product source of truth; agent state stays in a separate store.
2. **Agent tool sprawl** — keep only core tools; hide UI-only actions from the model.
3. **Unsafe autonomy** — approvals stay mandatory for production/deep scans, PR creation and risk acceptance.
4. **User confusion** — plain-language modes; "Can I launch?" remains the primary experience.

### Must not delay Phase 1

SSO, SCIM, VPC, self-hosting, cloud scanning, ServiceNow, SIEM, advanced compliance, advanced RBAC and private workers must never delay Phase 1 work.

## Removed in the 2026-09-25 condensation

The 2026-07-04 deep-audit sections (B1–B13: SSRF, RBAC and tenant-isolation remediation, schema retrofits, sandbox and egress design, cost and determinism controls, backlog-to-sprint mapping), the completed implementation records (growth layer, agent-integration program, Sprint 10 BYOK Local/Desktop), and the release-gate, sprint-status and ordered-next-work sections (C2–C5) were removed as completed history owned by `codebase.md`, `PRD.md` and `AGENTS.md`. The verbatim originals remain in Git history (`10ec5f25^`).
