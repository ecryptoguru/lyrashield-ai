# LyraShield AI — Whitepaper

**Version 1.0.0 — 2026-09-12**

> The authoritative public description of LyraShield AI: the problem, the product, the evidence model, the commercial structure, and the boundaries of what we claim. Companion documents: [`litepaper.md`](./litepaper.md) (executive overview) and [`yellowpaper.md`](./yellowpaper.md) (technical specification).

---

## Abstract

AI coding agents now write a large share of production software, and most of it ships without meaningful security review. LyraShield AI is an evidence-backed release-assurance layer built for that reality: it scans an authorized target, records exactly what was tested, separates detected risks from verified outcomes, proposes approval-gated fixes, retests them under server control, and packages the result as a shareable assurance report. It is deliberately designed to never claim more than its retained evidence supports.

## 1. The problem: the verification gap

AI-built software compounds three problems:

1. **Volume.** One builder can now produce what a team produced. Review capacity did not scale with output.
2. **Characteristic failure modes.** AI-generated apps repeatedly fail in the same ways — exposed secrets, missing authorization checks, unsafe dependency choices, over-permissive agent tool surfaces — which generic scanners were not organized to catch.
3. **Unverifiable assurance.** "We scanned it" answers nothing. Buyers, clients, and reviewers need to know what was tested, what was found, what was fixed, and what was proven — and what was not.

The market response has been more scanners. But findings are not assurance. A scanner that reports 25 issues and proves nothing about the rest of the surface produces triage work, not a decision.

## 2. Product definition

LyraShield AI is an evidence-backed release-assurance product for AI-built software. It is not a generic vulnerability scanner, a certification service, or a substitute for an authorized penetration test.

One operating loop, identical across every surface:

```text
Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report
```

The product promise:

- Connect an authorized repository, web app, or API.
- Record what was tested and what could not be tested.
- Separate detected risks, retest-confirmed outcomes, independently verified findings, and inconclusive results.
- Explain risks in plain language while retaining technical evidence.
- Produce approval-gated fix proposals, server-owned retests, and shareable assurance reports.
- Never claim broader coverage or certainty than retained evidence supports.

### 2.1 Two modes, one account

| Mode              | Execution           | Commercial model                              | Model cost                                    |
| ----------------- | ------------------- | --------------------------------------------- | --------------------------------------------- |
| **Cloud**         | Hosted app + worker | Subscription                                  | Paid by LyraShield                            |
| **Local/Desktop** | Customer machine    | One-year BYOK license with perpetual fallback | Paid by customer through supplied credentials |

Both modes share the same engine and core loop. Optional Cloud Sync moves selected Local findings into the Cloud dashboard — the bridge that upgrades a privacy-first Local user into a Cloud subscriber. Nothing syncs by default.

### 2.2 Who it serves

Phase 1 serves AI app builders, founders, agencies, small SaaS teams, and developers who need to check an app before launch, review a pull request, monitor a target on a schedule, remediate findings, or send a defensible report to a client, investor, or engineering lead.

Phase 2 (roadmap, §10) serves security, platform, and regulated teams needing SSO, SCIM, advanced policy, private workers, and compliance evidence — around the same loop, never a different one.

| Audience                 | Framing                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| AI-assisted solo builder | "You shipped it quickly. Check it before you launch."                        |
| Small SaaS team          | A security-review artifact: findings, fixes, retest, and a shareable report. |
| Agency / dev shop        | Add a security report to each client handoff.                                |
| Enterprise AppSec        | One loop from builder workflows to governed controls, audit trail, CI gates. |

## 3. Product surface

The product is live in **open beta with open registration** at `https://app.lyrashieldai.com/sign-up`.

### 3.1 Cloud application

- Email/password, GitHub OAuth, and Google OAuth sign-in with email verification; workspaces, memberships, roles, projects, and targets.
- Scan admission, queueing, preflight, lifecycle events, cancellation, schedules, and fail-closed worker readiness.
- Findings with normalization, CWE/OWASP metadata, evidence states, candidates, receipts, manifests, retests, reports, and notifications.
- Fix proposals, approval-gated fix pull requests, and server-owned retests with loop closure on merged fix branches.
- LyraShield Score, private snapshots, opt-in public scorecards, badges, referrals, and privacy-bounded analytics.
- CLI, MCP server (stdio and remote Streamable HTTP with hosted OAuth), agent plugin, SDK, and a diff-aware GitHub Action.
- One adaptive dashboard for every role: a state-derived next action, posture with exact evidence scope, compact metrics, and progressive disclosure. Presentation never changes permissions, scan behavior, or evidence semantics.
- Billing (dual payment gateways), entitlements, usage metering, minute packs, grace, overage, checkout, portal, and webhook processing.
- Affiliate applications, attribution, commission ledger, fraud controls, payout ledger, and partner dashboard.

### 3.2 Local/Desktop

A desktop application (macOS and Windows) that runs scans on the user's machine against the user's own AI credentials:

- Signed licenses (ed25519) with offline operation, one-year update eligibility, and perpetual fallback to the last eligible build.
- BYOK credential storage in the OS keychain; no LyraShield model keys are embedded in the app.
- Optional authenticated Cloud Sync; telemetry off by default. Code, findings, and keys never leave the machine unless the user explicitly syncs.

### 3.3 Marketing and free tools

- Canonical site at `https://lyrashieldai.com` with structured data, sitemap, `llms.txt`, and integration guides.
- **Lite Check** at `/scan` — a passive, outside-only, no-signup check of a public URL, isolated on a separate scanner origin.
- Browser-local tools (launch checklist, headers/CORS checker, secret scanner, RLS helper, JWT inspector, AI App Security scanner) whose inputs never leave the browser.
- A public methodology page documenting the release-verdict scale.

## 4. The evidence model

Evidence discipline is the product. The contract that every scan obeys:

### 4.1 Evidence states

| State                             | Meaning                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `DETECTED`                        | Scanner reported a candidate with retained provenance.                                                   |
| `VALIDATED`                       | Server-owned deterministic retest confirmed the originating condition is absent under complete coverage. |
| `VERIFIED`                        | Independent trusted verification evidence exists.                                                        |
| `INCONCLUSIVE`                    | Coverage, evidence, or verifier result is insufficient.                                                  |
| `NOT_ASSESSED` / `NOT_APPLICABLE` | Control was not evaluated or does not apply.                                                             |

### 4.2 Result integrity rules

- Engine output is untrusted and bounded; every claim passes through manifest, coverage-receipt, candidate, and verification-receipt boundaries.
- Confidence never sets `verified`; engine-only absence remains `INCONCLUSIVE`.
- Direct status updates cannot set terminal `FIXED` — `FIXED_PENDING_RETEST` holds until a trusted retest receipt exists.
- Retest validation binds to stored immutable evidence: both the original scan and the retest scan must carry stored manifests, exact revisions or matching checksums, and complete deterministic coverage. Missing identity stays `INCONCLUSIVE`.
- Evidence uploads fail closed: checksum plus a valid encryption key reference, or nothing.
- Retries never duplicate findings, evidence, usage, webhooks, payouts, or commissions.

## 5. Assurance features

### 5.1 Vibe Security 50

A versioned coverage contract (`vibe-security-50/1.1.0`): 50 controls across deterministic, hybrid, engine-led, and evidence-required strategies. Every full scan records one immutable receipt per control. A control counts as a finding only when evidence was returned; "no finding" is never presented as "passed." Seven operational controls are honestly marked `EVIDENCE_REQUIRED` because no code or URL scan can prove them.

### 5.2 Launch Gate

A named, versioned readiness standard (`lyrashield-gate/1.0.0`): a pure function over stored evidence producing `READY`, `NOT_READY`, or `INSUFFICIENT_EVIDENCE`. Verdicts persist append-only per target under row-level security, refresh after every terminal scan state and every merged fix PR, and are exposed to CI through `lyrashield gate --verdict` with a stable 0/1/2 exit-code contract. Target types the coverage registry does not cover can never earn `READY`.

### 5.3 Launch Readiness Report

The shareable form of the verdict: a frozen allowlisted payload, an ed25519 signature over its checksum from a server-owned key, 30-day share tokens, and a public verify endpoint. MEDIUM/LOW findings are disclosed as not gate-evaluated rather than silently counted as zero.

### 5.4 AI-Built Failure Taxonomy

A public, citable catalog (`ai-built-failure-taxonomy/1.0.0`) of how AI-built apps characteristically fail, with every class traced to the live controls that detect it. Exposed read-only at `/api/taxonomy/ai-built-failures`.

### 5.5 WebMCP Assurance

Fourteen deterministic controls (WEBMCP-01…14) over browser-registered agent tool surfaces: annotation/behavior mismatch, cross-origin exposure, durable mutation without confirmation, embedded secrets, prompt-injection surface, spec drift, and contract budgets. Runs in the public no-login Security Lab (browser-local), full repository scans, the CLI, and a guarded subset in the GitHub Action.

### 5.6 AI App Security

Eight deterministic signals (AI-01…08) mapped to the OWASP Top 10 for LLM Applications (2025): prompt-injection input validation, sensitive data in LLM context, AI library supply chain, LLM output in dangerous sinks, unbounded agent permissions, system-prompt exposure, unauthenticated vector/RAG access, and missing LLM consumption limits. The mapping is a readiness mapping — not an OWASP endorsement, certification, or universal-detection claim.

### 5.7 Lite Check and scorecards

The free Lite Check returns a distinct result — never the official LyraShield Score. Authenticated scans produce a deterministic, versioned score (0–100 + grade); users may opt in to a public scorecard carrying only an allowlisted payload — never findings, severities, target URLs, or repository identity. Sharing is role-restricted, audit-logged, revocable, and superseded when a newer scan exists.

## 6. Distribution

| Surface                 | Role                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `lyrashield` CLI        | Scan, findings, reports, `check-diff`, `gate` with stable exit codes             |
| `@lyrashield/mcp`       | MCP server over stdio and remote Streamable HTTP with hosted OAuth               |
| Agent plugin / registry | 30 registry entries across 26 preferred client surfaces                          |
| GitHub Action           | Account-less, diff-aware PR gate emitting SARIF, running on the user's runner    |
| Public API `/api/v1`    | Additive-only contract with a 90-day deprecation policy (see `api-stability.md`) |

## 7. Security and trust architecture (overview)

- **Tenancy.** Every protected operation checks session, workspace membership, and permission; every workspace query is explicitly scoped, enforced at the database by row-level security with `FORCE RLS`. The production runtime role is neither superuser nor `BYPASSRLS`.
- **Audit.** Sensitive mutations write hash-chained audit events through a single advisory-locked transaction that owns chain ordering.
- **Evidence storage.** Private, checksum-bound, encrypted (AES-256-GCM envelope encryption), workspace-isolated, and fail-closed.
- **Network.** URL inputs pass SSRF validation; DNS is resolved, validated, and pinned at connection time; every redirect hop is revalidated. Worker public egress is denied by default; approved fetching goes through an authenticated SSRF-safe proxy. Repository execution is sandboxed: non-root, bounded resources, deny-by-default egress.
- **Agents.** Model-facing inputs are normalized and injection-guarded. Mutating actions require permission and, where consequential, single-use approval bound to the exact action and input hash. Remote OAuth is read-only by default; delegated writes revalidate membership, permission, scope, expiry, and idempotency on every call.
- **Platform administration.** A hidden, noindex read console restricted to exactly two allowlisted, verified, TOTP-enrolled operators; bearer credentials and workspace roles never grant access.

## 8. Commercial model

Two product lines, one meter (protected targets + agent-minutes), two gateways (global + India).

### 8.1 Cloud plans

**Line 1 — Scan** (find what's wrong):

| Plan    |     Monthly | Annual | Agent-min/mo | Targets | Deep scans |
| ------- | ----------: | -----: | -----------: | ------: | ---------- |
| Trial   | $0, 14 days |      — | 100 one-time |       3 | No         |
| Starter |         $29 |   $295 |          300 |       5 | No         |
| Pro     |         $99 |   $950 |        1,200 |      15 | Yes        |

**Line 2 — Launch Assurance** (prove it to a third party):

| Plan             |     Monthly | Annual | Agent-min/mo | Targets | Self-serve |
| ---------------- | ----------: | -----: | -----------: | ------: | ---------- |
| Launch Assurance |        $499 | $4,188 |        6,000 |      50 | Yes        |
| Enterprise       | from $1,500 |      — |       custom |  custom | No         |

- Deep scans meter at 3×; failed scans are never billed; cancelled scans bill elapsed time only.
- Overage (Launch Assurance only): $0.15/agent-minute behind a user-set spend limit. Minute packs: 100/$15, 250/$30, 500/$50, valid 180 days.
- A mid-scan balance of zero grants at most 15 minutes of non-bankable grace; a scan starting at zero is rejected.
- Subscriptions, allowances, usage, packs, and overage are owned by the **account**, not the workspace — a subscription follows the person; workspace membership never shares another member's allowance.
- Non-refundable except where required by law or for duplicate collection, unauthorized payment, or a confirmed payment error.

### 8.2 Local/Desktop licenses

| SKU                 | Price                               | Includes                                             |
| ------------------- | ----------------------------------- | ---------------------------------------------------- |
| Individual          | $199 launch / $299 regular one-time | 1-year license, up to 3 machines, perpetual fallback |
| Team (perpetual)    | $99/seat one-time (min 3 seats)     | 1 year of updates, license manager                   |
| Team (subscription) | $149/seat/year                      | Continuous updates                                   |
| Cloud Sync add-on   | $49/seat/year                       | Sync Local findings to a Cloud workspace             |

Update renewal $59/seat/year; 10% off at 10+ seats; no lifetime deals.

### 8.3 Affiliate program

Application-gated partner program: **25% recurring for 12 months** on Cloud monthly subscriptions (30% at 10+ active referrals), flat 25% on annual, **20% one-time** on Local licenses. 60-day last-click attribution with promo-code override; $100 minimum payout, monthly net-30, 30-day hold, tax-form gate; automatic clawback on provider-confirmed refunds or chargebacks. No commission on trials, packs, or self-referrals.

### 8.4 Funnel

The free surface is the acquisition engine: Lite Check, six browser-local tools, the GitHub Action, and a technical-content program all route to account creation or the Local license. There is no permanent free product tier — the free tools give real value but no official score and no full loop.

> **Note:** production purchase admission and final publishable pricing remain founder-gated launch decisions.

## 9. Claims and assurance boundary

LyraShield maintains a claims-readiness policy covering five prohibited claim categories. The governing principle: public claims must be **evidence-backed, scope-bounded, and limitation-aware**.

| Claim                           | Status today | What it would require                                          |
| ------------------------------- | ------------ | -------------------------------------------------------------- |
| "SOC 2 compliant"               | Never said   | CPA-issued Type II attestation report                          |
| "Certified" (e.g. ISO 27001)    | Never said   | Accredited-body certificate                                    |
| "Guarantees security"           | Never said   | Bounded scope, published eval corpus, liability cap, insurance |
| "AI safety tested"              | Bounded only | Named-framework evaluation + independent review                |
| "Adversarial robustness proven" | Never said   | No accepted formal certification exists for LLM systems        |

What can be said honestly today:

- "Evidence-backed release assurance for AI-built software."
- The prompt-injection guard was evaluated against the OWASP Gen AI red-teaming case set (42 cases, four areas; 85.7% matched declared outcomes) and observed against an MLCommons AILuminate demo prompt set — first-party results published on `/ai-safety`, not a third-party evaluation.
- Deterministic clean retests may be described as retest-confirmed — not independent exploit verification.

Any move from "evidence-backed" to "certified," "compliant," "guaranteed," or "proven robust" requires external attestation or a reproducible evaluation corpus — not a marketing decision.

## 10. Roadmap

Phase 2 direction (enterprise governance) proceeds only after current launch gates close and design-partner interviews validate demand:

- **Pilot wedge:** OIDC enterprise sign-in, role-management over the existing permission model, workspace policy enforcement, an outbound-only private worker, audit export, and evidence retention — proven with 2–3 design partners.
- **Productized demand:** SCIM, SAML where demanded, customer-managed evidence storage and keys, retention/deletion controls, evidence-backed compliance mappings (no certification claim), data residency where contracted.
- **Requested integrations:** one generic signed outbound webhook preferred over many narrow adapters; SIEM, Jira/Linear, release gates, CI/CD, identity directories as named customers require.
- **Expansion branch (choose one):** customer VPC, self-hosted, MSP/MSSP operations, or deeper scanner coverage — selected on validated demand.

Explicitly deferred: broad ASPM/attack-path platform, large speculative integration catalog, IaC/container/cloud-account scanning, local/self-hosted models, and a human-validated pentest add-on.

The verbatim Phase 2 planning archive is retained in git history; this section is the current direction overlay.

## 11. Success measures

Measured with production evidence, not aspirational copy: onboarding completion and time-to-first-scan; scan completion/failure rates; finding action, fix-proposal, and retest rates; evidence completeness and independently-verified finding rate; report/share/referral conversion; trial-to-paid conversion; and worker capacity and recovery time.

## Appendix A — Methodology versioning

Public-facing contracts are named and versioned so results are reproducible and citable:

| Contract                           | Version                                    |
| ---------------------------------- | ------------------------------------------ |
| Vibe Security 50 coverage contract | `vibe-security-50/1.1.0`                   |
| Launch Gate verdict standard       | `lyrashield-gate/1.0.0`                    |
| AI-Built Failure Taxonomy          | `ai-built-failure-taxonomy/1.0.0`          |
| WebMCP detector / inventory        | `webmcp-assurance/2`, `webmcp-inventory/1` |
| URL scan capability registry       | `url-scan/2.0.0`                           |
| AI assurance framework mapping     | `ai-assurance-mapping/1.0.0`               |
| Affiliate terms                    | `2026-08-18-v1`                            |

## Appendix B — Glossary

- **Agent-minute** — active agent-loop wall time metered on engine-backed Cloud scans; deterministic checks do not consume agent-minutes.
- **BYOK** — bring your own key: Local/Desktop runs on customer-supplied AI credentials.
- **Evidence state** — the explicit verification status carried by every finding and control receipt (§4.1).
- **Launch Gate** — the versioned readiness standard producing per-target verdicts (§5.2).
- **Loop closure** — the automatic retest created when an approval-gated fix branch merges.
- **Perpetual fallback** — a lapsed Local license keeps the last eligible build; it never deactivates.
- **Sponsor account** — the persisted account that created a scan (or its recorded delegate); the payer of record.

---

_This whitepaper describes product behavior and commercial structure as of the version date. It is not a certification, an audit report, an offer of security outcomes, or investment advice. Internal unit economics, provider cost detail, and operational receipts are intentionally excluded and remain private._
