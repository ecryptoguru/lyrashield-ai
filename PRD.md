# LyraShield AI — Product Requirements and Release Plan

> Current source of truth: 2026-08-21. This file owns product strategy, accepted scope, release gates, and ordered backlog. [codebase.md](./codebase.md) owns implementation mapping; [AGENTS.md](./AGENTS.md) owns operating rules and the immediate handoff. Running code, schema, CI, and live evidence override prose.

## 1. Product definition

LyraShield AI is an evidence-backed release-assurance product for AI-built software. It is not a generic vulnerability scanner, a certification service, or a substitute for an authorized penetration test.

Core loop:

```text
Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report
```

Product promise:

- Connect an authorized repository, web app, or API.
- Record what was tested and what could not be tested.
- Separate detected risks, retest-confirmed outcomes, independently verified findings, and inconclusive results.
- Explain risks in plain language while retaining technical evidence.
- Produce approval-gated fix proposals, server-owned retests, and shareable assurance reports.
- Never claim broader coverage or certainty than retained evidence supports.

### Product modes

| Mode          | Commercial model                              | Execution             | Model cost                                    |
| ------------- | --------------------------------------------- | --------------------- | --------------------------------------------- |
| Cloud         | Subscription                                  | Hosted app and worker | Paid by LyraShield                            |
| Local/Desktop | One-year BYOK license with perpetual fallback | Customer machine      | Paid by customer through supplied credentials |

Both modes share the same core loop. Optional Cloud Sync moves selected Local findings into the Cloud dashboard; nothing syncs by default.

### Users and jobs

Phase 1 serves AI app builders, founders, agencies, small SaaS teams, and developers who need to:

- check an app before launch;
- review a pull request;
- monitor a target on a schedule;
- understand and remediate findings;
- send a defensible client, investor, or engineering report.

Phase 2 serves security, platform, regulated, and large engineering teams needing SSO, SCIM, advanced policy, private workers, VPC/self-hosting, compliance evidence, data controls, and enterprise integrations.

### UX and claims principles

- Default language: “Check my PR,” “Test my app,” “Full launch review,” “Proof,” “Fix proposal,” and “Retest.” Hide scanner jargon unless requested.
- Findings remain detected until trusted independent evidence exists.
- A deterministic clean retest may be described as retest-confirmed; it is not independent exploit verification.
- Confidence is triage metadata, never proof.
- Reports are evidence summaries, not SOC 2, ISO, GDPR, PCI, or security certification.
- No accuracy, benchmark, speed, exclusivity, customer, or universal-safety claim without measured founder-approved evidence.
- Public copy must not name the upstream engine or imply automatic Fix PR execution.

## 2. Current product surface

LyraShield AI is live in open beta with open registration at `https://app.lyrashieldai.com/sign-up`. The marketing email form is an optional updates subscription, not an access gate.

### Cloud application

Implemented:

- Better Auth email/password, GitHub OAuth, optional Google OAuth, email verification, sessions, account deletion, and anonymization.
- Workspaces, memberships, invitations, roles, projects, repository/URL/API targets, onboarding, and active-workspace persistence.
- BullMQ scan admission, queueing, preflight, target serialization, lifecycle events, cancellation, orphan reconciliation, schedules, and fail-closed worker readiness.
- Findings, normalization, CWE/OWASP metadata, SCA, secrets, deterministic URL/API checks, AI App Security checks, evidence states, candidates, receipts, manifests, retests, reports, notifications, and launch readiness.
- LyraShield Score, private snapshots, public scorecards, cards, badges, privacy-bounded analytics, referrals, and social sharing.
- Agent actions, exact-input approvals, MCP over stdio and Streamable HTTP, hosted OAuth, CLI login/install/doctor flows, SDK, agent registry, and portable agent plugin.
- Polar/Razorpay billing, plans, trials, entitlements, usage metering, minute packs, grace, overage logic, checkout, portal, and webhook processing.
- Affiliate applications, attribution, commission ledger, fraud controls, payout ledger, dashboard, clawbacks, and reserves.
- A fixed, non-destructive private-beta AI safety test catalog with exact host, credential, request, duration, response, and storage bounds. It is not arbitrary fuzzing or proof of adversarial robustness.

Deliberately unavailable:

- fresh GitHub installation binding without provider-backed ownership proof;
- automatic Fix PR execution without a server-generated immutable patch bound to the exact approval;
- intrusive exploit replay or arbitrary model-generated PoC execution;
- public AI App Security score sharing;
- claims that every finding is independently verified.

### Local/Desktop

Implemented in code:

- Tauri v2 application for macOS and Windows.
- ed25519 signed licenses with deterministic canonical JSON and cross-language golden vector.
- OS-keychain BYOK storage; no LyraShield model keys embedded in the app.
- ChatGPT/OpenAI sign-in through the engine and Azure OpenAI key/endpoint configuration.
- local scan lifecycle and optional Cloud Sync.
- seven rolling days of offline operation after successful server verification,
  one-year update eligibility, and perpetual fallback to the last eligible build;
  update expiry never disables the installed eligible build or local scans.
- explicit revocation hard-stop and a user-confirmed signed updater pipeline.

Local/self-hosted models are deferred because the engine currently requires GPT-5.6 Terra/Luna.

### Marketing and free tools

Live:

- canonical site `https://lyrashieldai.com` on Astro/Cloudflare Workers;
- apex TLS and permanent `www` redirect with path/query preservation;
- D1, KV, Rate Limit binding, sitemap, robots, `llms.txt`, RSS, schema, headers, PostHog, and 161-article program;
- passive Lite Scanner at `https://scanner.lyrashieldai.com` with Turnstile, scoped CORS, rate limits, Supabase, Upstash, and abuse reporting;
- five browser-local privacy-first tools and browser-local AI App Security scanner;
- authenticated application origin with open registration.

The passive Lite Scanner is separate from the BullMQ/engine repository pipeline.

### AI App Security and safety-evaluation boundary

- The deterministic AI App Security scanner maps eight signals, AI-01 through AI-08, to the OWASP Top 10 for LLM Applications (2025). The browser-local tool covers AI-01, AI-02, and AI-04 through AI-08 without upload; paid repository scans add AI-03 enrichment, optional bounded triage, private versioned scoring, and evidence persistence.
- The public `/ai-safety` page renders a recorded 2026-08-13 evaluation artifact: 42 OWASP cases across four areas, with 36 matching declared outcomes (85.7%), plus an observational AILuminate demo run of 292 prompts across three categories, where 13 matched guard rules (4.5%). The AILuminate number is not a pass rate or model-safety score.
- The historical evaluation runner was removed as unused in `b96e597`; the result artifact remains versioned, but a clean checkout cannot reproduce that run until a replacement runner is added. The current live AI safety catalog is a different, fixed five-case contract for authorized non-production endpoints.

## 3. Scan and evidence contract

### Target routing

- `REPO`: external controlled engine plus deterministic repository scanners.
- `WEB_APP`: deterministic URL scanner with profile-bound discovery and probes.
- `API`: deterministic OpenAPI scanner; Standard/Deep require a validated public HTTPS spec URL.
- Cloud, container, and IaC targets remain roadmap work.

### Model routing and budgets

| Profile  | Root model | Specialist model | Reasoning                     | Provider cap |
| -------- | ---------- | ---------------- | ----------------------------- | -----------: |
| Safe     | Luna       | Luna             | medium                        |        $1.20 |
| Quick    | Luna       | Luna             | medium                        |        $1.20 |
| Standard | Luna       | Luna             | medium                        |        $3.20 |
| Deep     | Terra      | Luna             | medium root, high specialists |        $5.00 |
| Custom   | Terra      | Luna             | medium root, high specialists |        $5.00 |

Rules:

- `resolveEngineProfile()` is the routing authority.
- `resolveScanBudgetUsd()` is the protected budget authority.
- A positive workspace policy may lower but never raise the selected cap.
- `LYRASHIELD_LLM` is a validated fallback, not a routing bypass.
- Deep/Custom are deterministic two-tier profiles, not a Luna-to-Terra cascade.
- Actual model, standard/long-context tokens, cache reads/writes, requests, and reconciled cost stay in the private ledger. Dashboard users see minutes, not provider spend.
- URL/API scans use no repository AI engine and have zero AI budget.

### Evidence states

| State                             | Meaning                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `DETECTED`                        | Scanner reported a candidate with retained provenance.                                                   |
| `VALIDATED`                       | Server-owned deterministic retest confirmed the originating condition is absent under complete coverage. |
| `VERIFIED`                        | Independent trusted verification evidence exists.                                                        |
| `INCONCLUSIVE`                    | Coverage, evidence, or verifier result is insufficient.                                                  |
| `NOT_ASSESSED` / `NOT_APPLICABLE` | Control was not evaluated or does not apply.                                                             |

Result integrity requirements:

- engine output is untrusted and byte/field/count bounded;
- every new claim passes through manifest, coverage receipt, candidate, and verification receipt boundaries;
- direct status updates cannot set terminal `FIXED`; use `FIXED_PENDING_RETEST` until a trusted retest receipt exists;
- engine-only absence remains inconclusive;
- evidence uploads fail closed and require checksum plus valid encryption key reference;
- retries must not duplicate findings, evidence, usage, webhooks, payouts, or commissions.

## 4. Product workflows

### Onboarding

1. Create account and workspace.
2. Connect GitHub or create URL/API target.
3. Choose goal and review profile.
4. Run preflight.
5. Submit scan.
6. Follow live timeline.
7. Review evidence states and limitations.
8. Create fix proposal, retest, report, or schedule.

### Scan lifecycle

```text
QUEUED → PREFLIGHT → RUNNING → VERIFYING → COMPLETED
```

Terminal alternatives: `FAILED`, `CANCELLED`, `TIMED_OUT`, `STOPPED_BUDGET`, and `REQUIRES_APPROVAL`.

Repository jobs are admitted only while a live worker heartbeat exists. Queue/database drift fails closed; paid work is never automatically replayed after an ambiguous failure.

### Remediation

- User may create and inspect a fix proposal.
- Consequential actions require permission and exact-input approval.
- Fix PR endpoint accepts no client patch, branch, title, or body.
- PR creation remains disabled until server-generated patch provenance and GitHub installation ownership are bound.
- Retest scope derives from the server-owned source scan, never a client-selected replacement.

### Reports and sharing

- Reports use immutable creation-time snapshots.
- Shared reports are revocable and expiry-aware.
- Public scorecard payloads use a strict allowlist and never expose target/repository/finding details, raw IPs, user agents, or captions.
- Human view/share events are allowlisted, deduplicated, and privacy bounded; they are not external impressions or verified conversions.

## 5. Commercial model

### Cloud plans

| Plan    |      Monthly price | Included minutes | Targets | Deep                   |
| ------- | -----------------: | ---------------: | ------: | ---------------------- |
| Trial   |     $0 for 14 days |              100 |       3 | No                     |
| Starter |                $29 |              300 |       5 | No                     |
| Pro     |                $99 |            1,200 |      15 | Yes                    |
| Team    |               $299 |            4,000 |      50 | Yes + optional overage |
| Agency  | $499 / contact-led |           Custom |  Custom | Yes                    |

Annual prices: Starter $295, Pro $950, Team $2,690. INR uses the internal USD × 100 pricing rule. Do not publish or change pricing without founder approval.

Minute packs: 100/$15, 250/$30, 500/$50; 180-day validity. Team overage: $0.15/min when explicitly enabled with a spend limit. Deep/Custom consume minutes at 3×.

Usage draw order: current monthly pool, oldest valid pack, then allowed overage. Every grant/debit/refund has an idempotency key. A scan that crosses zero may use at most 15 minutes of non-bankable mid-scan grace; a scan starting at zero is rejected.

### Local pricing

- Individual launch: $199; regular: $299; up to three machines.
- Team perpetual: $99/seat; team subscription: $149/seat/year.
- Update renewal: $59/seat/year.
- Cloud Sync add-on: $49/seat/year.
- 10% team discount at 10+ seats.
- Local licenses are non-refundable except chargeback handling.

### Affiliate terms

- Cloud monthly: 25% recurring for 12 months; 30% at 10+ active referrals.
- Cloud annual: flat 25%; no tier kicker.
- Local: 20% one-time.
- No commission on trials, minute packs, or self-referrals.
- Attribution: promo code, then 60-day last-click cookie, then unattributed.
- Payout: $100 minimum, monthly net-30 on the 15th, 30-day hold, tax-form gate.
- New affiliate reserve: 25% for 90 days.
- Rails: RazorpayX for India; Payoneer globally. Provider integrations remain provisioning-dependent.

## 6. Security and trust requirements

### Identity and tenancy

- Better Auth owns identity/session tables; Prisma owns application data.
- Every protected operation checks session, workspace membership, and permission.
- Every workspace query is explicitly scoped by `workspaceId`.
- AsyncLocalStorage carries request context; `withWorkspaceRLS()` applies transaction-local DB context.
- Production `DATABASE_URL` role must have `rolsuper=false` and `rolbypassrls=false`.
- Direct workspace tables and child tables use fail-closed RLS; code-level scoping remains defense in depth.

### Network and sandbox

- URL inputs allow HTTP(S) only and reject credentials, unsafe DNS/IP ranges, and unsafe redirect hops.
- DNS is resolved, validated, and pinned at connection time.
- Repository sandbox uses non-root execution, bounded resources, read-only/ephemeral storage where possible, no-new-privileges, and deny-by-default egress.
- Worker arbitrary public access is denied; approved public fetching goes through the authenticated SSRF-safe proxy.
- BullMQ uses managed authenticated TLS Redis. Upstash REST credentials are used only for distributed rate limiting.

### Secrets, evidence, and audit

- No plaintext provider, target, or signing secret in Prisma, logs, reports, or desktop source.
- Production secrets use managed secret references.
- Structured logger recursively redacts sensitive keys and values.
- Evidence storage is private, checksum-bound, encrypted, workspace-isolated, and fail-closed.
- Sensitive mutations write audit events through the extended Prisma client; its advisory-locked transaction owns hash-chain ordering.
- Webhooks verify provider signatures and insert idempotent `WebhookEvent` records before processing.

### Agent and GitHub boundaries

- Model-facing inputs pass `normalizeInput()` and `PromptInjectionGuard`.
- Read actions require permission; mutating actions require permission and, where consequential, approval.
- Approval is atomic, single-use, expiry-aware, and bound to exact action name plus input hash.
- Remote OAuth write scope never bypasses per-action approval.
- Fresh GitHub callback state alone cannot create an integration.
- No automatic merge or client-authored patch execution.

## 7. Architecture summary

```text
Next.js web/API
  ├─ Better Auth + workspace RBAC
  ├─ Prisma/PostgreSQL + RLS
  ├─ Billing, licenses, affiliates, reports, MCP/OAuth
  └─ BullMQ enqueue
       └─ Dedicated worker VM
            ├─ deterministic scanners
            ├─ controlled Python engine for repository targets
            ├─ sandbox containers
            ├─ private evidence storage
            └─ authenticated egress proxy

Astro/Cloudflare marketing
  ├─ public content and browser-local tools
  └─ passive Lite Scanner origin

Tauri Local/Desktop
  ├─ OS-keychain BYOK
  ├─ local engine/sandbox
  └─ optional Cloud Sync
```

Detailed file and package mapping: [codebase.md](./codebase.md).

## 8. Current production evidence

### Standard/Luna acceptance — 2026-08-21

- Scan ID: `cmt35aj1s000001hck9fmguzk`
- Target: `ecryptoguru/OnboardingAI2@1689f3607d68764e09769535df8e368c4d5ad2fe`
- Terminal state: `COMPLETED`
- Duration: 11m 42s
- Routing: 184 requests, all `azure_ai/gpt-5.6-luna` at medium reasoning; no Terra
- Tokens: 8,227,004 input, 6,066,725 cached input, 30,844 output
- Provider and billed cost: `$0.597148`, independently reconciled under the `$3.20` cap
- Usage debit: 12 Standard agent-minutes
- Results: 24 retained findings, 24 candidates, 24 verification receipts, 56 coverage receipts
- Independent verification: zero findings
- Limitation: AI App Security layer reached its 200-file bound
- Stored manifest checksum: `5813c6dc06bcb89b2386cb80563a93e928be96bfe7371a85c930704127606dec`

This proves bounded runtime, Luna routing, accounting, receipt persistence, and terminal completion for that target and revision. It does not prove universal coverage, finding correctness, or security.

### AI App Security coverage remediation — 2026-08-21

- PR #386 (`8ee6fd5`) preserves the historical scan's bounded result while correcting future scan coverage and evidence.
- File selection now prioritizes production/config sources, excludes generated artifacts, and uses mode caps of 200 for Quick/Safe, 500 for Standard, and 1,000 for Deep/Custom while retaining byte, time, walk-depth, and entry bounds.
- Discovery records eligible, scanned, skipped, and reason counts plus a bounded skipped-path sample. These limits flow into scoring, coverage issues, dashboard disclosure, and an immutable `ai_app_security` family receipt; incomplete AI coverage cannot support a clean claim.
- A 217-file regression fixture proves Quick remains honestly bounded at 200 while still scanning vulnerable production code, and Standard evaluates all 217 files.
- Production deployment: app revision `lyrashield-app--0000155`; worker product `8ee6fd50e55bfb6d3ca20c6b9209e8a9423c2056`; worker digest `sha256:d7dd33c2823a6152cc5b99d27ce6ef9e1acccf7cb203fff9def4550789054b01`; worker health and `/api/ready/scans` passed.

### Infrastructure evidence — 2026-08-21

- Web revision: `lyrashield-app--0000155`, ready for scans.
- Worker product revision: `8ee6fd50e55bfb6d3ca20c6b9209e8a9423c2056`.
- Worker digest: `sha256:d7dd33c2823a6152cc5b99d27ce6ef9e1acccf7cb203fff9def4550789054b01`.
- Engine revision: `dd588c379ae6614e0914b8adb41d94f0c1e86c26`; engine version 1.2.1.
- Upstash BullMQ `rediss://` returned `PONG`; queue was empty before acceptance and heartbeat was live.
- Azure public Redis `6379` rule is deleted.
- Legacy Redis container is stopped and restart-disabled, retained only for rollback.
- Direct arbitrary public fetch denied; authenticated proxy public fetch allowed; loopback denied with `ssrf_blocked`.
- Five-minute DNS-pin refresh stayed active through the paid scan without restarting the worker.
- Encrypted backup and isolated restore completed schema, RLS, audit-chain, and application-startup verification.

## 9. Release status

### Complete

- Open registration, authenticated app origin, marketing site, passive Lite Scanner, and public tools.
- Core Target-to-Report loop in code.
- Current Standard/Luna production acceptance.
- Managed TLS BullMQ Redis and negative egress proof.
- Dedicated worker compute, immutable worker promotion, readiness heartbeat, and rollback image.
- Backup/restore drill.
- Polar/Razorpay test credentials, product/price maps, webhook secrets, signed smoke, and non-charge objects.
- Cloud billing, usage, Local/Desktop, and affiliate implementations merged.

### Remaining before broader paid/untrusted exposure

1. Prove private S3-compatible evidence persistence, encryption, retrieval, and failure behavior in production.
2. Connect readiness, queue, provider, cost, and worker logs to actionable monitoring, alerts, capacity evidence, and named incident ownership.
3. Run worker cancellation and queue recovery under production failure injection without replaying ambiguous paid work.
4. Verify live-provider entitlement and usage metering events; keep live paid activation founder-controlled.
5. Complete current production license-signing activation and proof through Azure Key Vault.
6. Provision RazorpayX and Payoneer payout API access and tax-form workflow.
7. Verify scorecard metadata/card formats/badge, revocation/expiry, referral continuity, human-event deduplication, and external unfurls on public domains.
8. Triage the 24 Standard findings and obtain independent verification where warranted.
9. Select and authorize a controlled Deep/Terra target, then retain separate routing, cost, receipt, image, and terminal-state evidence.
10. Verify production runtime DB role is neither superuser nor `BYPASSRLS` before traffic growth.

### Deferred

- Security Copilot sidebar and visual security plans/recaps.
- Compliance-lite evidence packs.
- IaC, container, cloud-account, and reachability scanning.
- Enterprise SSO/OIDC, SCIM, advanced policy, private worker, enterprise integrations, VPC/self-hosting, and data residency.
- Local/self-hosted model support.
- Human-validated pentest add-on.

### Known implementation and evidence debt

- User-facing API-key create/list/revoke lifecycle is not shipped.
- GitHub installation ownership still needs provider-backed proof before binding a fresh installation; Fix PR execution still needs a server-generated immutable patch/evidence artifact bound to exact approval.
- Replace provider-managed object-encryption key references with an explicit KMS/Vault design when the evidence-storage provider is finalized.
- Add the `Policy.maxBudgetUsd >= 0` database constraint before exposing policy CRUD.
- Complete AI-03 lockfile/advisory coverage, production triage provenance/accounting, private-score disposition carry-forward, report UX, and live calibration proof.
- The stored Standard-scan manifest checksum was retained, but naive JSONB reserialization did not reproduce it because key order changed. Persist canonical hash input or verification bytes before claiming deterministic database-retrieved checksum reproduction.
- Restore or replace the removed historical AI-safety evaluation runner before claiming the recorded benchmark can be rerun from a clean checkout.

## 10. Founder decisions

- Trademark clearance for LyraShield AI and `lyrashieldai.com`.
- Public paid-launch timing and final publishable pricing.
- Live Polar/Razorpay activation.
- Authorized provider/model and target for first controlled Deep/Terra scan.

## 11. Success measures

Measure with real production evidence, not aspirational copy:

- onboarding completion and time to submitted first scan;
- scan completion/failure/cancellation/orphan rate;
- cost, tokens, cache use, and agent-minutes by profile;
- finding action, disposition, fix-proposal, and retest rate;
- evidence completeness and independently verified finding rate;
- weekly monitoring adoption;
- report/share/referral conversion;
- trial-to-paid conversion, gross margin, and overage behavior;
- worker capacity, queue latency, recovery time, and incident rate.

## 12. Definition of done

A capability is done only when relevant layers are complete:

- schema and additive migration;
- Zod validation and authorization;
- workspace scoping and RLS behavior;
- audit event and idempotency where sensitive;
- loading, empty, error, accessibility, mobile, and cancellation states;
- tests and security regression coverage;
- lint, typecheck, tests, build, formatting, migration replay/drift, dependency/secret scan, and `git diff --check`;
- rendered browser proof for UI changes;
- deployed configuration and runtime evidence for production claims;
- provider delivery plus application-state verification for webhook claims;
- exact model/cost/receipt/terminal evidence for paid scan claims;
- documentation updated without overstating the result.

## 13. Documentation ownership

- [PRD.md](./PRD.md): product strategy, accepted scope, release status, backlog, and founder decisions.
- [Phase2.md](./Phase2.md): verbatim archive of original Phase 2 and future-roadmap material; historical status labels are not current truth.
- [codebase.md](./codebase.md): architecture, code map, runtime contracts, and compact implementation ledger.
- [AGENTS.md](./AGENTS.md): immediate handoff, non-negotiable rules, landmines, and execution queue.
- [product.md](./product.md): positioning and commercial decision register.
- [userguide.md](./userguide.md): end-user workflows and limitations.
- [monetization.md](./monetization.md): pricing and affiliate economics.
- `docs/deployment/*`: deployment and recovery runbooks.
- `docs/ops/*`: signing, desktop, RLS, and operational runbooks.
- [docs/README.md](./docs/README.md): documentation map and retention rules.
