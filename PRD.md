# LyraShield AI — Product Requirements and Release Plan

> Current source of truth: 2026-09-02 (post Deep Review v14 and the WP1–WP7 launch-assurance wave). This file owns product strategy, accepted scope, release gates, and ordered backlog. [codebase.md](./codebase.md) owns implementation mapping; [AGENTS.md](./AGENTS.md) owns operating rules and the immediate handoff. Running code, schema, CI, and live evidence override prose.

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

- Better Auth email/password, GitHub OAuth, optional Google OAuth, email verification, sessions, and reviewed account-deletion requests. Automated destructive deletion remains fail-closed until billing, audit, evidence, and legal-retention rules are approved.
- Workspaces, memberships, invitations, roles, projects, repository/URL/API targets, onboarding, and active-workspace persistence.
- BullMQ scan admission, queueing, preflight, target serialization, lifecycle events, cancellation, orphan reconciliation, schedules, and fail-closed worker readiness.
- Host-visible worker/engine temporary paths for Docker sandbox source mounts; pre-provider
  sandbox failures remain non-billable.
- Findings, normalization, CWE/OWASP metadata, SCA, secrets, deterministic URL/API checks, AI App Security checks, evidence states, candidates, receipts, manifests, retests, reports, notifications, and launch readiness.
- LyraShield Score, private snapshots, public scorecards, cards, badges, privacy-bounded analytics, referrals, and social sharing.
- Agent actions, exact-input approvals, MCP over stdio and Streamable HTTP, hosted OAuth, CLI login/install/doctor flows, SDK, agent registry, and portable agent plugin.
- One adaptive authenticated dashboard for every role: a state-derived next action, current posture with exact evidence scope, compact metrics, recent activity, and progressive disclosure for technical depth. Presentation never changes permissions, scan behavior, or evidence semantics.
- A hidden platform-operator console for bounded cross-workspace overview, user/workspace/scan lists, platform audit, and affiliate review. It is not a tenant-admin role and is not discoverable by ordinary users.
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
- retest validation is bound to stored immutable evidence: both the finding's original source scan and the retest scan must have stored result manifests, exact repository revisions (which may differ after a fix) or matching URL checksums, and complete deterministic coverage; missing or malformed identity stays `INCONCLUSIVE`;
- engine-only absence remains inconclusive;
- evidence uploads fail closed and require checksum plus valid encryption key reference;
- `Policy.maxBudgetUsd` is nullable but never negative (PostgreSQL check constraint);
- every result manifest binds exact worker execution provenance (product revision, worker image digest, engine revision) into its checksum; production workers fail closed before readiness without it;
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

Terminal alternatives: `FAILED`, `PARTIAL` (engine stopped with findings preserved — never reported as COMPLETED), `CANCELLED`, `TIMED_OUT`, `STOPPED_BUDGET`, and `REQUIRES_APPROVAL`.

Repository jobs are admitted only while a live worker heartbeat exists. Queue/database drift fails closed; paid work is never automatically replayed after an ambiguous failure. A mid-run spend ceiling is enforced both engine-side and by the worker polling live spend (SIGTERM at the grace-adjusted cap). After any terminal state the worker refreshes the target's gate verdict.

### Remediation

- User may create and inspect a fix proposal.
- Consequential actions require permission and exact-input approval.
- Fix PR endpoint accepts no client patch, branch, title, or body.
- The full fix-PR pipeline is wired end to end (v14): proposal creation enqueues deterministic patch generation from the engine's structured fix (`fix-generate` job, plan-tiered scope validation, encrypted evidence storage); findings carry the scanned `baseCommit` so patches apply against exactly the commit analyzed; a merged `lyrashield/fix-` branch triggers loop-closure — the PR is marked merged, a REAL retest scan is created and queued (bound to the NEW scan, never the finding's original terminal scan). Nothing auto-merges; every PR is an approval-gated proposal.
- Retest scope derives from the server-owned source scan, never a client-selected replacement.

### Launch gate and assurance reporting

- The Launch Gate is a named, versioned readiness standard (`lyrashield-gate/1.0.0`): a pure function over stored evidence producing READY / NOT_READY / INSUFFICIENT_EVIDENCE verdicts, persisted append-only per target (`GateVerdict`, RLS-protected). Coverage requirements derive from the scan registry; uncovered target types can never earn READY.
- The verdict is refreshed after every terminal scan state, after a merged fix PR, and on demand via `POST /api/gate/[targetId]`.
- The Launch Readiness Report renders the verdict as a shareable, verifiable artifact: frozen allowlisted payload (`buildLaunchReportPayload`), ed25519 signature over the checksum (server-owned key), 30-day share tokens, and a public verify endpoint. MEDIUM/LOW findings are disclosed as not gate-evaluated rather than counted as zero.
- The AI-Built Failure Taxonomy (`ai-built-failure-taxonomy/1.0.0`) is the named, public, citable catalog of how AI-built apps characteristically fail, with every class traced to live controls; exposed read-only at `/api/taxonomy/ai-built-failures`.
- WebMCP Assurance covers 14 controls (WEBMCP-01…14, including embedded-secret, prompt-injection-surface, spec-drift, and contract-budget detection on the tool surface).

### Reports and sharing

- Reports use immutable creation-time snapshots.
- Shared reports are revocable and expiry-aware.
- Public scorecard payloads use a strict allowlist and never expose target/repository/finding details, raw IPs, user agents, or captions.
- Human view/share events are allowlisted, deduplicated, and privacy bounded; they are not external impressions or verified conversions.

## 5. Commercial model

### Cloud plans

Two product lines (WP1 repricing, founder-confirmed 2026-08-29, in code at `packages/pricing/src/plans.ts`):

**Line 1 — Scan** (find what's wrong):

| Plan    |     Monthly | Annual |      Minutes | Targets | Deep |
| ------- | ----------: | -----: | -----------: | ------: | ---- |
| Trial   | $0, 14 days |      — | 100 one-time |       3 | No   |
| Starter |         $29 |   $295 |          300 |       5 | No   |
| Pro     |         $99 |   $950 |        1,200 |      15 | Yes  |

**Line 2 — Launch Assurance** (prove it to a third party):

| Plan             |     Monthly |             Annual | Minutes | Targets | Self-serve |
| ---------------- | ----------: | -----------------: | ------: | ------: | ---------- |
| Launch Assurance |        $499 | $4,188 (= $349/mo) |   6,000 |      50 | Yes        |
| Enterprise       | from $1,500 |                  — |  custom |  custom | No         |

- Team ($299) was removed and merged into Launch Assurance. The `TEAM` enum value is retained in the schema for existing rows; the plan is not sold.
- Annual discount ladder is deliberately 15 / 20 / 30 across the two lines.
- Overage: $0.15/min, Launch Assurance only, with a user-set spend limit. Deep/Custom consume minutes at 3×.
- Integrations (GitHub, Slack, Jira) moved down to Pro. RBAC and shared reports stay at Launch Assurance and above.
- Failed scans are never billed; cancelled scans bill elapsed time only (no 1-minute floor).

Minute packs: 100/$15, 250/$30, 500/$50; 180-day validity.

Usage draw order: current monthly pool, oldest valid pack, then allowed overage. Every grant/debit/refund has an idempotency key. A scan that crosses zero may use at most 15 minutes of non-bankable mid-scan grace; a scan starting at zero is rejected.

Cloud subscriptions, Local licenses, and minute packs are non-refundable except where required by law or for duplicate collection, unauthorized payment, or a confirmed payment error. Provider-confirmed reversals still revoke entitlements and claw back related commissions.

Do not publish or change pricing without founder approval.

### Local pricing

- Individual launch: $199; regular: $299; up to three machines.
- Team perpetual: $99/seat; team subscription: $149/seat/year.
- Update renewal: $59/seat/year.
- Cloud Sync add-on: $49/seat/year.
- 10% team discount at 10+ seats.
- Local licenses follow the product-wide non-refundable policy and narrow exceptions above.

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
- Platform administration is a separate global boundary: only the exact configured emails `ecryptoguru@gmail.com` and `ankit@lyrashieldai.com` may hold `PLATFORM_OPERATOR`; each account must be unique, email-verified, and TOTP-enrolled.
- Admin reads require a server-confirmed browser-cookie session with recent server-stamped TOTP. Bearer/API-key credentials and workspace roles cannot cross the boundary; unauthorized routes return not found and carry noindex/noarchive metadata.
- Critical admin mutations require a same-origin JSON request, fresh TOTP challenge, short-lived action-specific single-use nonce, authority revalidation inside the database transaction, and atomic platform audit. Affiliate mutations remain disabled until that full transaction boundary is connected.
- Production role provisioning uses a dedicated workflow with an exact confirmation phrase and system database credential. Preflight is read-only; apply revokes prior sessions/elevations and creates the bootstrap audit receipt. Code presence does not prove production accounts were provisioned.

### Network and sandbox

- URL inputs allow HTTP(S) only and reject credentials, unsafe DNS/IP ranges, and unsafe redirect hops.
- DNS is resolved, validated, and pinned at connection time.
- Repository sandbox uses non-root execution, bounded resources, read-only/ephemeral storage where possible, no-new-privileges, and deny-by-default egress.
- Worker arbitrary public access is denied; approved public fetching goes through the authenticated SSRF-safe proxy.
- BullMQ uses managed authenticated TLS Redis. Upstash REST credentials are used only for distributed rate limiting.
- Exact health/readiness probes are locally bounded without Upstash commands. Upstash
  initialization and runtime failures use a 60-second retry cooldown while ordinary endpoints retain their
  in-memory fallback limits.

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

### Standard/Luna acceptance — 2026-08-26

- Scan ID: `cmt9el7p7000001hdjnjo90wk`
- Target: `ecryptoguru/OnboardingAI2@1689f3607d68764e09769535df8e368c4d5ad2fe`
- Terminal state: `COMPLETED`
- Duration: 10m 9s
- Routing: 189 requests, all `azure_ai/gpt-5.6-luna` at medium reasoning; no Terra
- Tokens: 8,549,456 input, 6,535,778 cached input, 136,759 cache-write input, 32,092 output; no long-context bucket
- Provider cost: `$0.57879951`; rate-card and billed cost: `$0.578800`, reconciled under the `$3.20` cap
- Usage debit: 10 Standard agent-minutes from 596,659 ms wall time, 1× multiplier
- Results: 25 retained findings; 17 `DETECTED`, 8 `INCONCLUSIVE`
- Independent verification: zero findings
- Coverage: engine, SCA, secrets, agent configuration, ML supply chain, and AI App Security `COMPLETED`; URL not applicable
- AI App Security discovery: 217/217 eligible files and 1,956,360 bytes scanned; zero skipped files or reached limits
- Stored manifest v5 checksum: `ebfa3fb0ba19d97d8d9393432f8dbe37078b4bcf0367a7b91c21fe54a78e5687`
- Execution identity: product `7abd9baa8943c8e25f954ad6e6d9bd2a6c84d6b7`, worker `sha256:fd1888ccaedc9d9f2618398c1924571f23a03fed05efb6b772c922cf43d7cf01`, engine `852b1ed7ff76d177cef4db5aa1cfbd3bbe6d2664`, sandbox `sha256:73067cefe2138c89c1f63abb597f006f66eae22dca332a6b01398d870a638dcf`; sandbox cleanup completed

This proves bounded runtime, Luna routing, accounting, receipt persistence, and terminal completion for that target and revision. It does not prove universal coverage, finding correctness, or security.

The 2026-08-21 acceptance scan `cmt35aj1s000001hck9fmguzk` remains historical evidence. Its 200-file AI App Security bound and 24 unverified findings are unchanged.

### AI App Security coverage remediation — 2026-08-21

- PR #386 (`8ee6fd5`) preserves the historical scan's bounded result while correcting future scan coverage and evidence.
- File selection now prioritizes production/config sources, excludes generated artifacts, and uses mode caps of 200 for Quick/Safe, 500 for Standard, and 1,000 for Deep/Custom while retaining byte, time, walk-depth, and entry bounds.
- Discovery records eligible, scanned, skipped, and reason counts plus a bounded skipped-path sample. These limits flow into scoring, coverage issues, dashboard disclosure, and an immutable `ai_app_security` family receipt; incomplete AI coverage cannot support a clean claim.
- A 217-file regression fixture proves Quick remains honestly bounded at 200 while still scanning vulnerable production code, and Standard evaluates all 217 files.
- Current production deployment: app `lyrashield-app--0000195`, scanner `lyrashield-scanner--0000176`, and egress proxy `lyrashield-egress-proxy--0000045` run product `16a1fb7014ce3cbf9e56b69bff5074a5d0d8e0dd` at 100% traffic. CI `32966602739`, release `32967467190`, candidate/public smoke, worker promotion, post-recovery Docker health, and `/api/ready/scans` passed.
- Production includes PR #426 billing-staging hardening, PR #432 Redis/egress efficiency, and PR #450 secure scan-owned checkout recovery. All Cloud and Local purchase admissions remain `off`; no live purchase admission or provider-hosted checkout is proven by this release.
- A billing-staging-only admission and deployment contract is implemented in code. It is bound to an explicit staging marker, isolated Azure origin, Sandbox/Test providers, an HttpOnly access session, exact-main-SHA images built in the staging registry, and separate `app_runtime_staging`/least-privilege `app_system_staging` database URLs. It cannot enable production admission, does not enable live billing, and is not runtime or hosted-checkout proof until the protected workflow and browser/provider evidence actually run.

### Infrastructure evidence — 2026-08-26

- Web revision: `lyrashield-app--0000195`, ready for scans.
- Worker product revision: `16a1fb7014ce3cbf9e56b69bff5074a5d0d8e0dd`.
- Worker digest: `sha256:cb0f836eb54825517e900468a87c6d09b5e9df636121b49d8683b1766849fceb`.
- Engine revision: `852b1ed7ff76d177cef4db5aa1cfbd3bbe6d2664`; engine version 1.2.1.
- Upstash BullMQ `rediss://` returned `PONG`; queue was empty before acceptance and heartbeat was live.
- Azure public Redis `6379` rule is deleted.
- Legacy Redis container is stopped and restart-disabled, retained only for rollback.
- Direct arbitrary public fetch denied; authenticated proxy public fetch allowed; loopback denied with `ssrf_blocked`.
- A changed OSV pin triggered the drain-safe path during the accepted scan. New admission and readiness paused, the paid job completed without interruption or replay, and the next timer restarted the exact worker digest. Docker health and scan readiness returned green. The temporary planned-drain `503` must be distinguished from unexpected worker failure in alerting.
- Redis/egress efficiency code is deployed. Its 30-day idle-command estimate falls from 324,019 to 132,495 commands (59.11%); this remains a model until live command metrics and longer-window capacity evidence are retained.
- Encrypted backup and isolated restore completed schema, RLS, audit-chain, and application-startup verification.

## 9. Release status

### Complete

- Open registration, authenticated app origin, marketing site, passive Lite Scanner, and public tools.
- Core Target-to-Report loop in code.
- Current Standard/Luna production acceptance.
- Managed TLS BullMQ Redis and negative egress proof.
- Dedicated worker compute, immutable worker promotion, readiness heartbeat, and rollback image.
- Backup/restore drill.
- Billing code retains signed-webhook, replay, catalog-map, and disposable-account coverage. Provider-hosted end-to-end Sandbox/Test staging receipts remain outstanding.
- Read-only Brave provider review on 2026-08-26: Razorpay Live is activated with six matching INR Cloud plans and one enabled eight-event webhook. Polar Live has a production token, fifteen private Cloud/pack/Local products, and an enabled lifecycle webhook. No provider mutation or payment was performed; every purchase admission remains `off`.
- Cloud billing, usage, Local/Desktop, and affiliate implementations merged.
- The single adaptive dashboard and the bounded platform-admin console are implemented. Exact-two preflight/apply passed, and both named administrators completed fresh independent Google-plus-TOTP browser proof across every admin destination; bearer-only and workspace-only access remained denied.
- Production evidence-storage round-trip/fail-closed, actionable notification acknowledgment, terminal-cost disposition, queue-orphan recovery, and Key Vault managed-identity signing proofs passed. See `docs/ops/launch-assurance-status-2026-08-26.md` for exact receipts and limitations.
- SEO/AEO/GEO foundations include canonical/schema metadata, sitemap and robots controls, dated `llms.txt`, `agents.md`, answer-engine crawler stanzas, integration guides, comparison/research pages, and content validation.
- Current assurance hardening (PRs #428–#430): nonnegative policy budgets enforced by PostgreSQL check constraint, explainable deterministic finding priority with limitation disclosure, immutable retest validation bound to stored manifests, removal of raw evidence-storage URIs from finding detail, worker execution provenance (product revision, worker image digest, engine revision) bound into manifest checksums with production fail-closed readiness, actionable Azure alert provisioning with readback and idempotent reruns, and a bounded host-side dry-run-first launch-assurance orchestrator composing existing evidence, cancellation, and queue-reconciliation paths. Evidence, alert, queue, and signing production receipts are recorded in `docs/ops/launch-assurance-status-2026-08-26.md`; every future deployment or profile still requires revision-bound proof.

### Remaining before broader paid/untrusted exposure

1. Merge and deploy the scorecard canonical-origin fix, then repeat live canonical/OG readback. The temporary internal scorecard otherwise passed cards, badge, referral, privacy, deduplication, LinkedIn unfurl, and revocation checks.
2. Run restricted Polar Sandbox and Razorpay Test Mode checkout/webhook/refund/cancellation/license/replay proof. Keep every production admission off. Razorpay hosted-checkout methods above INR 15,000 remain transaction-unproven.
3. Retain longer-window Redis command/capacity evidence; provision RazorpayX and Payoneer payout API access plus tax-form workflow.
4. Triage the 25 findings from Standard scan `cmt9el7p7000001hdjnjo90wk` and obtain independent verification where warranted.
5. Select and authorize a controlled Deep/Terra target, then retain separate routing, cost, receipt, image, and terminal-state evidence.
6. Capture authenticated client-matrix receipts plus webmaster indexing and answer-engine citation observations; code, simulated crawlers, and one LinkedIn unfurl do not prove universal discovery.

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
- Complete AI-03 lockfile/advisory coverage, production triage provenance/accounting, private-score disposition carry-forward, report UX, and live calibration proof.
- The stored Standard-scan manifest checksum was retained, but naive JSONB reserialization did not reproduce it because key order changed. Persist canonical hash input or verification bytes before claiming deterministic database-retrieved checksum reproduction.
- Restore or replace the removed historical AI-safety evaluation runner before claiming the recorded benchmark can be rerun from a clean checkout.

## 10. Founder decisions

- Trademark clearance for LyraShield AI and `lyrashieldai.com`.
- Public paid-launch timing and final publishable pricing.
- Enable production Polar/Razorpay purchase admissions.
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
