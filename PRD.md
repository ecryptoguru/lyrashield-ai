# LyraShield AI — Product Requirements and Release Plan

> Current production evidence: 2026-10-31 IST (deployed product revision `6739563df7dad585cef1be14cedcb978bc0a5219`, released by run `41117355986`; marketing remains at `0d8fc0f6c126271aa966ca895608cec2460f8cb4`). This file owns product strategy, accepted scope, release gates, and ordered backlog. [codebase.md](./codebase.md) owns implementation mapping; [AGENTS.md](./AGENTS.md) owns operating rules and the immediate handoff. Running code, schema, CI, and live evidence override prose.

## 1. Product definition

LyraShield AI is an evidence-backed release-assurance product for AI-built software. It is not a generic vulnerability scanner, a certification service, or a substitute for an authorized penetration test.

Core loop:

```text
Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report
```

Product promise:

- Connect an authorized repository, web app, or API.
- Record what was tested and what could not be tested.
- Separate detected risks, deterministic retest outcomes, and inconclusive results. `VERIFIED` is reserved for future independent verification and is not produced by current scans.
- Explain risks in plain language while retaining technical evidence.
- Produce approval-gated fix proposals, server-owned retests, and shareable assurance reports.
- Never claim broader coverage or certainty than retained evidence supports.

### Differentiators (USPs)

The eight commitments that separate LyraShield from point scanners and generic SAST. Each is a design property, not a detection-performance claim, and public copy must keep them inside the claims boundary (§1 UX and claims principles, [policies.md](./docs/policies.md)):

1. Evidence states instead of confidence scores (§3).
2. Coverage organized around how AI-built apps fail — AI-Built Failure Taxonomy, AI App Security AI-01–AI-08 (OWASP LLM Top 10, 2025), WebMCP controls (§4).
3. Agent-native distribution — CLI, MCP (21 tools), portable Agent Plugin, 51-entry registry / 48 preferred client surfaces, account-less GitHub Action (§2).
4. Approval-gated fix loop with automatic retest and gate re-evaluation on merge (§4 Remediation).
5. Versioned Launch Gate verdicts plus signed, publicly verifiable reports and release-identity confirmation (§4 Launch gate).
6. Honest coverage ledger — Vibe Security 50 (`vibe-security-50/1.2.0`) per-control outcomes; "no finding" never reads as "passed" (§3).
7. Two modes, one loop — Cloud subscription and BYOK Local/Desktop with perpetual fallback (§1 Product modes).
8. Fail-closed trust architecture — RLS tenancy, untrusted bounded engine output, execution provenance bound into manifest checksums (§6).

The public narrative versions of this list live in `docs/litepaper.md` §3 and `docs/whitepaper.md` §2.0; keep the three in step when one changes.

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
- Notification delivery: the dashboard scan feed and workspace-configured Slack/Discord delivery remain supported. Personal email and in-app preference controls are disabled because they have no effect; stored preference rows are preserved for possible future implementation. Push preferences are unavailable.
- Workspace integration configuration is stored as workspace-bound encrypted artifacts; the database keeps a reference rather than the webhook secret. The existing account-deletion outbox now queues those artifacts for retryable cleanup with account deletion. This does not enable automated self-service account deletion.
- LyraShield Score, private snapshots, public scorecards, cards, badges, privacy-bounded analytics, referrals, and social sharing.
- Agent actions, connection-bound delegated workflows, MCP over stdio and Streamable HTTP, hosted OAuth, CLI login/connect/install/doctor flows, SDK, agent registry, and portable agent plugin.
- Workspace API-key management is implemented in the current source: Owners and Admins can create, list, and revoke workspace keys. Keys have read/write scopes, are bound to a workspace and their creator, reveal the raw value once, and persist only its SHA-256 hash. This source status does not establish a production release revision.
- One adaptive authenticated dashboard for every role: a state-derived next action, current posture with exact evidence scope, compact metrics, recent activity, and progressive disclosure for technical depth. Presentation never changes permissions, scan behavior, or evidence semantics.
- A hidden platform-operator console for bounded cross-workspace overview, user/workspace/scan lists, platform audit, and affiliate review. It is not a tenant-admin role and is not discoverable by ordinary users.
- Polar/Razorpay billing, plans, trials, entitlements, usage metering, minute packs, grace, overage logic, checkout, portal, and webhook processing.
- Affiliate services and existing-partner operations include attribution, commission ledger, fraud controls, payout ledger, dashboard, clawbacks and reserves. New application intake is currently paused.
- A fixed, non-destructive private-beta AI safety test catalog with exact host, credential, request, duration, response, and storage bounds. It is not arbitrary fuzzing or proof of adversarial robustness.
- Myra, the AI support agent, on marketing and dashboard surfaces behind explicit default-off `MYRA_*` feature flags: reviewed knowledge base, premium chat generation, feedback capture, session/daily caps and hardened production launch gates.
- Delegated outbound connectors (GitHub, Slack) with fail-closed admission (`off`/`canary`/`public` plus a workspace allowlist), Agency-tier plan gating, workspace connector APIs and bounded output caps; no dashboard tab yet.
- Scan attachments: workspace-scoped evidence-file inputs with strict RLS, a deletion outbox, fail-closed resolution (host paths are never accepted) and dashboard/CLI support.
- The review-changes scan workflow (`scan-workflows/1.0.0`) with parity across API, SDK, CLI, MCP and Desktop.
- Release-identity confirmation for signed reports: opt-in and capability-bound, returning `MATCH`, `MISMATCH` or `UNAVAILABLE` for a caller-supplied commit or artifact digest.
- A truthful scan-quality surface (`lyrashield-scan-quality/1.0.0`) exposed through the dashboard, `/api/v1` and the CLI.
- A gated authenticated-assessment staging beta for authorized scope checks.

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

Local/self-hosted models are deferred because the engine currently requires the GPT-6 Sol/Luna provider contract.

### Marketing and free tools

Live:

- canonical site `https://lyrashieldai.com` on Astro/Cloudflare Workers;
- apex TLS and permanent `www` redirect with path/query preservation;
- D1, KV, Rate Limit binding, sitemap, robots, `llms.txt`, RSS, schema, headers, PostHog, and 166-article program;
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
- `WEB_APP`: Safe/Quick use deterministic URL checks; Standard and Deep/Custom select engine-backed profiles plus deterministic discovery and probes.
- `API`: deterministic OpenAPI checks; Standard and Deep/Custom also select the engine and require a validated public HTTPS spec URL. Engine-backed URL/API tiers require domain verification and a scan-scoped relay grant.
- Cloud, container, and standalone IaC targets remain roadmap work. Repository scans include bounded SAST and IaC scanner families.

Standard and Deep repository scans condition PHP-specific analysis and optional
post-scan engine triage context on detected PHP projects. Monorepo PHP services retain their own scope;
non-PHP repositories do not run the PHP analyzers or receive that PHP context.
Missing, unreadable or bounded discovery and missing exact runtime identity remain
explicit coverage limits. Initial engine instructions are unchanged; PHP context
is limited to existing bounded triage excerpts, without additional engine calls.
PHP coverage includes exact Composer lock inventory in
shared SCA, a reviewed branch-specific runtime advisory catalog, passive runtime
declarations and bounded application source checks. Runtime declarations and
public headers remain unverified supporting evidence. A clean source retest cannot validate a
deployed PHP runtime fix. Dedicated Composer proposals preserve the generic
lockfile prohibition and open draft PRs for customer compatibility tests and
review. See the [PHP detection and remediation runbook](./docs/php-security.md)
for supported inputs, scope limits and operational evidence requirements. This
source capability does not establish a deployed release or universal PHP
vulnerability coverage. The free [PHP2Shell checker](https://lyrashieldai.com/tools/php2shell-checker)
is a browser-local guided review of reported versions and conditions, with a
separate dated CVE-2026-115560 notice. It sends no target requests, uploads no
inputs and cannot verify deployment or compromise.

Repository dependency coverage is format-specific. Exact supported lock inputs include npm package locks/pnpm/Yarn, pinned Python requirements, Composer, registry Cargo.lock and supported Gemfile.lock identities. Go module/workspace inputs use an isolated pinned native resolver and bounded metadata broker. Declarations alone, private/git/path/mutable/ambiguous sources, unsupported Maven/Gradle inputs and exhausted bounds retain incomplete coverage; lock inventory does not establish reachability. The capability registry is `packages/types/src/dependency-capabilities.ts`. These are local v26 source capabilities; final image and runtime qualification are separate.

### Model routing and budgets

| Profile  | Root model | Specialist model | Reasoning                     | Provider cap |
| -------- | ---------- | ---------------- | ----------------------------- | -----------: |
| Safe     | Luna       | Luna             | medium                        |        $1.20 |
| Quick    | Luna       | Luna             | medium                        |        $1.20 |
| Standard | Luna       | Luna             | medium                        |        $3.20 |
| Deep     | Sol        | Luna             | medium root, high specialists |        $5.00 |
| Custom   | Sol        | Luna             | medium root, high specialists |        $5.00 |

Rules:

- `resolveEngineProfile()` is the routing authority.
- `resolveScanBudgetUsd()` is the protected budget authority.
- A positive workspace policy may lower but never raise the selected cap.
- `LYRASHIELD_LLM` is a validated fallback, not a routing bypass.
- Deep/Custom are deterministic two-tier profiles, not a Luna-to-Sol cascade.
- Paid scans route through GPT-6 Sol/Luna with strict receipts; GPT-6 accounting fails closed and engine runtime is bounded by an accepted deadline with a tunable cache-routing knob.
- Actual model, standard/long-context tokens, cache reads/writes, requests, and reconciled cost stay in the private ledger. Dashboard users see minutes, not provider spend.
- URL/API Safe/Quick have zero AI budget. Standard selects GPT-6 Luna with a $3.20 provider cap; Deep/Custom select GPT-6 Sol-root/Luna-specialist routing with a $5 cap. These are source profile contracts, not completed live scan acceptance. The remote relay rejects opaque CONNECT tunnels; a sandbox-local TLS adapter converts HTTPS client traffic into inspectable requests using the installed sandbox CA. Composed local curl and Chromium navigation/fetch acceptance passed allowed requests and denied path/method/redirect requests without TLS bypass, including rejection of an invalid upstream certificate. Exact-image production deployment and a paid URL engine scan remain unverified.

### Standards evidence mapping

`standards-registry/1.1.0` renders mapped evidence, not verified compliance. Default views use the actual OWASP Top 10 2021 categories, API Top 10 2023, LLM Top 10 2025, CWE Top 25 2024, and a clearly labeled subset of ASVS 5.0.0 L1 requirements. Five unverified hidden mappings (ATLAS, CIS, AISVS, ISO 27001, and SLSA) are excluded until their identifiers, editions, and observable scope are reviewed. A scanner completion can credit only a supported mapped category; a finding is counted once per category even when both CWE and OWASP tags match. Bounded or unreadable scanner inputs cannot produce complete coverage.

### Evidence states

| State                             | Meaning                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `DETECTED`                        | Scanner reported a candidate with retained provenance.                                                   |
| `VALIDATED`                       | Server-owned deterministic retest confirmed the originating condition is absent under complete coverage. |
| `VERIFIED`                        | Future independent verification state; no current finding receives it.                                   |
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

1. Create an account, then explicitly choose an eligible workspace or create one. The server validates current permissions and commits the choice atomically across repeated tabs/requests; it does not adopt the oldest membership.
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

New scans atomically claim one initiating-user slot across workspaces and create a sponsor-account capacity reservation. Funding is FIFO per account; waiting for capacity does not reserve minutes or permit a second user scan. Runtime is limited by funded whole agent-minutes with a five-second stop margin. Terminal status alone does not release a slot: execution stop and accounting completion must be proven. Unknown execution or settlement retains an explicit review hold. Failed/pre-provider runs are nonbillable; observed excess beyond reserved funding is recorded as absorbed rather than charged. Legacy receipts retain their original version.

Interactive, retest and scheduled URL reviews use the same relay availability policy. Transient entitlement reads, worker/relay unavailability and user/target contention leave the scheduled occurrence pending. Permanent denial advances once with a bounded reason. The winning occurrence, scan, slot, reservation, event and lastScanId commit together. Unknown queue acknowledgement retains the same durable scan identity; only proven prepublication failure of that fresh identity can restore its occurrence.

### Remediation

- User may create and inspect a fix proposal.
- Consequential actions require current permission and a valid browser-confirmed connection grant bound to the workflow, target, profile, and idempotency key. The hosted remote MCP endpoint refuses nondelegated mutations, including write-scoped API-key calls, with `connect_required`; the legacy `PENDING`/`approvalId` round-trip is retired there. Out-of-grant delegated calls are denied.
- Fix PR endpoint accepts no client patch, branch, title, or body.
- The full fix-PR pipeline is wired end to end (v14): proposal creation enqueues deterministic patch generation from the engine's structured fix (`fix-generate` job, plan-tiered scope validation, encrypted evidence storage); findings carry the scanned `baseCommit` so patches apply against exactly the commit analyzed; a merged `lyrashield/fix-` branch triggers loop-closure — the PR is marked merged, a REAL retest scan is created and queued (bound to the NEW scan, never the finding's original terminal scan). Nothing auto-merges; every PR is an approval-gated proposal.
- Retest scope derives from the server-owned source scan, never a client-selected replacement.
- A durable immutable-proposal execution identity precedes remote PR mutation. Status/retry reconciles that same remote branch/PR after local persistence or approval-completion failure; it does not open another PR. The exact approved base must still equal the default-branch head. Stale input directs retest/regeneration; pending approval is not an opened PR.

### Launch gate and assurance reporting

- The Launch Gate is a named, versioned readiness standard (`lyrashield-gate/2.4.0`): a pure function over stored evidence producing READY / NOT_READY / INSUFFICIENT_EVIDENCE verdicts, persisted append-only per target (`GateVerdict`, RLS-protected). Coverage requirements derive from the scan registry; uncovered target types can never earn READY. An explicitly incomplete PHP Windows Brotli applicability receipt also prevents READY. Existing verdicts retain their recorded version and checksums.
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

Two product lines (publishable schedule reaffirmed 2026-09-22; code authority is `packages/pricing/src/plans.ts`):

**Line 1 — Scan** (find what's wrong):

| Plan    |    Monthly | Annual |     Minutes | Targets | Deep |
| ------- | ---------: | -----: | ----------: | ------: | ---- |
| Trial   | $0, 7 days |      — | 60 one-time |       3 | No   |
| Starter |        $29 |   $295 |         210 |       5 | No   |
| Pro     |        $99 |   $950 |         850 |      15 | Yes  |

**Line 2 — Agency** (prove it to a third party):

| Plan       |     Monthly |             Annual | Minutes | Targets | Self-serve |
| ---------- | ----------: | -----------------: | ------: | ------: | ---------- |
| Agency     |        $499 | $4,188 (= $349/mo) |   4,500 |      50 | Yes        |
| Enterprise | from $1,500 |                  — |  custom |  custom | No         |

- Team ($299) was removed and merged into Agency. The `TEAM` enum value is retained in the schema for existing rows; the plan is not sold. The former `LAUNCH_ASSURANCE` plan ID remains stable for billing compatibility.
- Annual discount ladder is deliberately 15 / 20 / 30 across the two lines.
- Overage: $0.15/min, Agency only, with a user-set spend limit. Deep/Custom consume minutes at 3×.
- GitHub repo connection, RBAC, shared reports, retests, Evidence Vault, versioned verdicts, launch reports, and scorecards are permission-gated, not plan-gated. The GitHub Action is account-less; CLI and MCP connections are available across plans subject to permissions and scan admission.
- Repository MCP/WebMCP scanner findings are available on every plan. Starter and Pro allow one workspace member; Pro adds Deep/Custom scans. Agency sponsors one team workspace with up to five members including the buyer, sharing the buyer's 4,500 monthly minutes, plus higher limits and capped overage.
- Failed scans are never billed. A billable cancelled/partial model-backed run uses observed positive elapsed analysis rounded up to whole minutes, then the Deep/Custom 3× multiplier; displayed elapsed time is separate from charged agent-minutes.

Minute packs: 100/$15, 250/$35, 500/$65; 180-day validity. Purchase availability depends on billing permission and a supported checkout provider for the account's region.

Usage draw order: current monthly pool, oldest valid pack, then allowed overage. Every grant/debit/refund has an idempotency key. A scan that crosses zero may use at most 15 agent-minutes of non-bankable mid-scan grace after pool/packs, or eligible capped overage; Deep/Custom use the same multiplied unit. Reservation excludes capacity held by concurrent sponsored scans. A scan starting at zero is rejected.

Subscriptions, allowances, usage balances, packs, grace, and overage belong to the **account** (the user), not the workspace: one subscription follows the person across workspaces. In an Agency-sponsored workspace, up to five members draw from the persisted buyer's minute pool; other workspaces use each scanner's own account. The sponsor is recorded on each scan before execution. Annual plans receive a fresh monthly allowance each month of the term. Workspaces remain the resource/tenancy boundary and mirror plan state for display only.

Cloud subscriptions, Local licenses, and minute packs are non-refundable except where required by law or for duplicate collection, unauthorized payment, or a confirmed payment error. Provider-confirmed reversals still revoke entitlements and claw back related commissions.

This is the approved public launch schedule. Revisit it after sufficient paid utilization and conversion data exists; catalog or price changes still require founder approval.

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
- Delegated OAuth reads also apply a shared selected-target predicate to rows, counts, cursors, detail, scores and downloads. Empty grants return no target data; target-scoped readiness requires an explicit authorized target. Workspace RLS does not replace this narrower credential boundary.
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
- Remote OAuth is read-only by default. A browser-confirmed, connection-bound delegation may authorize selected workflows, targets, and scan profiles without repeated review-queue prompts; execution still rechecks current membership, permission, scope, expiry, and idempotency. Nondelegated hosted remote MCP mutations, including write-scoped API-key calls and legacy `approvalId` requests, receive `connect_required`; out-of-grant delegated calls are denied.
- Fresh GitHub callback state alone cannot create an integration.
- Repository acquisition and deterministic retest use fresh repository-specific contents:read installation tokens and recheck the active integration. This read path has no local/Redis token cache; the separate authorized installation-default token cache is encrypted and scoped by app identity, installation and grant.
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

### v26 production addendum — 2026-10-31 IST

Implementation [PR #1061](https://github.com/ecryptoguru/lyrashield-ai/pull/1061) merged as `0d8fc0f6c126271aa966ca895608cec2460f8cb4`. Its first release failed before migration during inactive-revision inventory; the original app/scanner were restored and the exact owned stop was subsequently released through the reviewed pre-migration abort. Preserve that failed receipt and its private VM audits. Corrective [PR #1062](https://github.com/ecryptoguru/lyrashield-ai/pull/1062) merged as `6739563df7dad585cef1be14cedcb978bc0a5219` after the three required checks passed on head `299401e6f119576a22783dcdc715fa322423ed23` in [CI 41115200994](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/41115200994).

[Production release 41117355986](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/41117355986) succeeded, including exact-image qualification/rehearsal, owned admission claim, drain, migrations, runtime grants, forced RLS, candidate checks, traffic promotion and exact owned-stop release. The retained independent readback records receipt `COMPLETE`, healthy active worker, active egress refresh timer, admission stop absent, four expected migration checksums applied and forced RLS on both new tables. Release logs separately attest runtime-principal grants. These VM/database observations come from the retained release report; this documentation refresh did not repeat privileged readback.

- Product source: `6739563df7dad585cef1be14cedcb978bc0a5219`.
- App/scanner web digest: `sha256:c73a978d3c9de1efa93b87e0e8524e775fa54cc1b627b8137a043541b7ce385b`; app `lyrashield-app--0000512` and scanner `lyrashield-scanner--0000486` each had one active replica and 100% traffic at retained readback.
- Worker digest: `sha256:33a769654ba9c68116d07b4986da673d95d38ed58c8be8369cdc33895d78e723`; engine unchanged at `3001517530300ca5f602536bfadcbd3c95ad3039`.
- Fresh public GET observations at `2026-10-30T21:39:21Z`–`21:39:27Z` (October 31 IST): scanner `/api/ready` returned 200 with database/Redis ready; curl app `/api/ready` returned 200 with database/Redis ready and app `/api/ready/scans` returned 200 with worker ready. An initial Python urllib app probe received 403; curl succeeded. These point-in-time HTTP observations do not independently prove image identity or authenticated scan execution.
- The last observed [scan-readiness workflow 41110605407](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/41110605407) failed its probe at October 30 18:52 UTC during the held first-cutover/recovery window. The final release completed at 20:48 UTC; the later public 200s are separate evidence, not a new successful readiness-workflow receipt.

Marketing remains at `0d8fc0f6c126271aa966ca895608cec2460f8cb4`; PR #1062 skipped marketing deployment. The retained preservation evidence matches all five landing motion/runtime/layout files and four original motion specs byte-for-byte to pre-v26 main `284523ca381ee0d6ffa62ce22e855f7ecae9518f`. Recorded live desktop and 390×844 smoke showed decoded film, scroll advancement, no horizontal overflow and menu Escape/focus behavior. This is not physical-device, Firefox, native-zoom or screen-reader acceptance; D5 remains deferred. No new loading policy or model routing is introduced.

The [original-ID dispositions (P1-1–P1-3 and P2-1–P2-30)](./docs/handoffs/v26-implementation-2026-10-30.md#original-issue-dispositions), [D1–D5 decisions and carried leads](./docs/handoffs/v26-implementation-2026-10-30.md#decisions-and-carried-leads) and [dated source review](./LyraShield-Deep-Review-v26-v3.md#historical-validation-performed--version-5) remain intact. The earlier local-only handoff is historical; this addendum establishes the later release evidence without relabeling historical tests. Public-network Go broker and production paid acceptance, positive GitHub Fix PR/retest, Firefox/native zoom/physical-device/screen-reader proof, schedule cursor fairness and broad Fix PR trace P3 remain unverified or follow-up work. Signed Desktop release remains deferred. Financial work is excluded from this refresh; no financial conclusions are added.

Retained release readback: `/Users/defiankit/Desktop/lyrashield-v26-evidence-20261030/production-release-6739563d-20261031.md` (local evidence artifact, not a published repository artifact). Recheck runtime state before operational action.

### Historical PHP release and production readback — 2026-10-27

PR #1043 merged as product `2d4e168da544306bf6cc9958a55f14bbfcb717e3`; [production release 40538483543](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40538483543) succeeded. Provider readback showed app `0000507`, scanner `0000481` and egress proxy `0000347` each receiving 100% traffic. Scan readiness returned HTTP 200. Independent VM readback confirmed healthy worker `sha256:690bac6ed42d1c450af94055e270d5f21baa937771ba828e7e4871e501067fbe`, matching product and engine `3001517530300ca5f602536bfadcbd3c95ad3039` provenance, and 23 PHP/Composer and coverage source hashes. Desktop release remains deferred.

Marketing readback on the earlier `d92315ac` revision: 17 pages and 368 unique links had no link errors. Two page-ready desktop/mobile passes across seven articles (28 observations) showed loaded images with alt text, six cluster links per article, checker and signup links, and no horizontal overflow. An earlier desktop observation before page load is inconclusive. Synthetic checker examples exercised the original advisories and separate session configuration guidance; mobile focused results and displayed the separate Windows advisory notice. The checker does not verify a deployed runtime.

Controlled private PHP target acceptance completed on product `d62303b1c2f96620b8c965d72db20bbf9c14833f` and worker `sha256:c71bd91e5ede9fa3b81fbe338ce488420c969f47e6cc910ebff2a8e028de33aa`: Standard scan `cmvnqwadx000101ly0gzgje7w` completed in 4m19s, and Deep scan `cmvnr3qd9000401lyejnwjg8c` completed in 11m43s. Both stored manifests are checksum `MATCH` at fixture revision `901f928a82a9bdbfea457870bf242599eebcb627`. Each retained 15 findings: nine bounded PHP source cases, two PHP2Shell runtime declarations, one Composer advisory and three generic container-root warnings. All nine vulnerable source cases were detected; all nine paired safe controls, the patched runtime/lock and the non-PHP service were excluded from the corresponding PHP checks. SCA coverage completed; bounded SAST and runtime-identity gaps remained explicitly incomplete. Routing, sandbox cleanup and scan-bound usage receipts were read back separately. This is specific-fixture evidence, not a universal accuracy or exploitability claim.

Composer end-to-end acceptance remains pending. On the prior `6e55def2` deployment, a controlled proposal succeeded with the installation-token cache absent; its encrypted artifact, source revision, patch/lock bytes and scoped Composer consistency were checked. An unchanged-source retest `cmvqrksed000101mb5r5v9gcz` completed with matching manifest and original fixture revision: the Symfony finding remained OPEN/DETECTED and the retest failed; the PHP runtime findings remained open. This is a negative control, not a patched-source proof. The approval-bound draft PR and positive retest remain pending; [PR #1043](https://github.com/ecryptoguru/lyrashield-ai/pull/1043) is deployed by [release 40538483543](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40538483543). Signed-in desktop and mobile checks opened the proposal confirmation without submitting it. On October 28, the GitHub App Contents and Pull requests write permissions were explicitly approved and accepted on its existing installation. The controlled PR attempt failed at an existing-file update because GitHub required the original blob SHA. At that recorded check, the corrected deployment and positive Composer workflow were not yet verified; refresh their evidence before making a readiness claim. No finding was manually marked fixed. Application compatibility and independently verified customer runtime identity, backports and earlier compromise remain separate evidence requirements.

GitHub Actions account admission is restored. [Fresh exact-main deployment 40293585533](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40293585533) previously deployed corrected PHP source `b4c8345359ed55c9d3a6f87eff739a31679aa503` under the unchanged guards. The older run `40234872448` failed closed on missing runtime-job history from its billing-blocked original attempt; do not bypass that check or treat its image build as a deployment.

### Recovery and monitoring readback — 2026-10-27

[Backup / isolated restore 40172080687](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40172080687), source `a9bd70c79aaf1f0914c22a60b85bd46601c2d3c6`, succeeded on October 25, including verified TLS, the exact encrypted backup object, schema/migrations, audit and application readiness, cleanup and public-safe proof publication. Relevant schema and restore implementation matched the reviewed current source. This closes the recorded October 11 proof-publication gap for this drill; it is not a production restore or proof for a future schema.

Live Azure inventory confirms the three reconciliation/catalog rules exist and are intentionally disabled under the October 12 noise policy; preserve that policy. Worker log ingestion is current, and a controlled invalid-state callback warning arrived in application Log Analytics. The operator email receiver is verified. After an earlier test had an unknown network outcome and no corresponding inbox or junk message was found, a later Azure test request succeeded and its sample metric alert arrived in the operator inbox on October 27. This proves delivery of that test, not that every alert rule will fire correctly.

### Previous production release — 2026-10-10

PR #992 merged as product revision `41462a3ff45f77e996823faf6d10f56053dec9e8`. Its automatic [production release run 38082773161](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/38082773161) completed successfully. The run built and pushed the images, selected the verified release digests, rehearsed the exact worker image against disposable services, promoted healthy Container Apps revisions and production traffic, then promoted the worker on its VM.

- Worker image digest: `sha256:91203cb94795cc8ae143e4a07da86a2fc3eac5e38ed1ebc862e46c1333d55007`.
- Engine revision: `3001517530300ca5f602536bfadcbd3c95ad3039`.
- The successful VM promotion step checked the configured Docker image reference, OCI product and engine labels, runtime product revision, runtime engine revision, runtime worker digest, Docker health and scan readiness against the release inputs.
- A fresh public `GET https://app.lyrashieldai.com/api/ready/scans` at `2026-10-10T20:53:34Z` returned HTTP 200 with `{"status":"ready","checks":{"worker":true}}`.

This establishes the release and scan-admission readiness for the deployed revision. It does not establish billing reconciliation, provider settlement, a paid scan on this revision, authenticated client use or commercial readiness. Recheck live state before operational action.

### Historical production release — 2026-10-01

The exact product revision `4822306e24f375800981bf282fd992a9c15dcde8` passed [main CI run 36905268255](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36905268255) and [production release run 36908006265](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36908006265). The release completed migrations, candidate and production smoke, queue preflight, Container Apps traffic promotion, and immutable worker digest promotion. It applied migrations `20261002000000_webhook_rejection_receipts` and `20261003000000_scan_delegated_authorization`.

- App revision `lyrashield-app--0000461`, scanner revision `lyrashield-scanner--0000436`, and egress-proxy revision `lyrashield-egress-proxy--0000302` were read back healthy at 100% traffic for the deployed product revision.
- Web/scanner image digest: `sha256:dbc43686e11f95a03d9f163c865683e3949ade4179839ef6d268e6ea55f9b78f`.
- Egress-proxy digest: `sha256:2951a50935f458c16495ccee9005990b2d4a5ba0a5470be1922a90733729bd24`.
- Worker image digest: `sha256:d38f8b080ae62b88ba9c6273be76abff42adf5a86b831bde5b19f6d6fce466dc`.
- Engine release pin: `9d90be5aaf92f86bb5c1ba55a8138545764fdd44`.
- [Scan-readiness workflow 36912801887](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36912801887) passed. A fresh unauthenticated `GET https://app.lyrashieldai.com/api/ready/scans` at `2026-10-01T20:15:18Z` returned HTTP 200 and `{"status":"ready","checks":{"worker":true}}` with `Cache-Control: no-store`.

This proves release and scan-admission readiness for that deployment. It does not prove billing reconciliation, provider settlement, a paid scan on the deployed revision, authenticated client use, or commercial readiness. The public OAuth metadata endpoints returned HTTP 200 and unauthenticated MCP returned HTTP 401 with the protected-resource challenge; no authenticated OAuth workspace call or client-runtime acceptance was performed.

### Operational blockers last verified 2026-10-01

- The report-only billing reconciliation failed its Polar order-list request on `2026-10-01T19:08:19Z` with HTTP 403 `insufficient_scope`. The operator alert recorded `reconciliation_drift`; the receipt is `completed=false`, with zero Polar orders checked and coverage from `2026-09-04T08:03:51Z` through `2026-10-01T19:08:18Z`. The receipt also shows zero Razorpay payments checked and no Razorpay provider failure. The worker runs the two providers sequentially, but the provider response count is not retained; do not treat this dated receipt as complete reconciliation or infer missing coverage from the zero count alone. No newer completed receipt is recorded here.
- At the 2026-10-01 readback, the release sync copied the app's Polar credential into worker Key Vault. Confirm the current grant and sync contract before changing credentials; do not assume a worker-only replacement will persist through a release. Use the guarded refresh/promotion procedure and rerun report-only reconciliation. Do not replay billing events, clear exceptions, or reset the coverage baseline to make the receipt green.
- The 2026-10-01 production rule readback found a live rule for `reconciliation_drift`, but no dedicated runtime rules for emitted `reconciliation_backlog` or `reconciliation_duplicates`. Current source `ops/monitoring/provision-alerts.sh` declares both rules and the 2026-10-11 release includes that source. The 2026-10-11 read-only inventory found both rules and `webhook-catalog-rejection` absent, with receiver delivery untested at that time. Later rule and notification evidence is recorded in §8.
- The 2026-10-11 isolated restore passed the then-current schema/migrations, audit and application readiness, then withheld its public proof at the verified-TLS gate; only successful verified backup connection and public proof remain open (see current evidence above).
- At the time of the 2026-10-01 deployment, the retest finalizer did not require checksum `MATCH` for both original and retest manifests. The audit did not read production finding records or prove an incorrect validation. Product revision `41462a3ff45f77e996823faf6d10f56053dec9e8` shipped the source fix on 2026-10-10; it remains in deployed revision `2d4e168da544306bf6cc9958a55f14bbfcb717e3`; see the current receipt above and §9.

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

### Historical AI App Security coverage remediation — 2026-08-21

- PR #386 (`8ee6fd5`) preserves the historical scan's bounded result while correcting future scan coverage and evidence.
- File selection now prioritizes production/config sources, excludes generated artifacts, and uses mode caps of 200 for Quick/Safe, 500 for Standard, and 1,000 for Deep/Custom while retaining byte, time, walk-depth, and entry bounds.
- Discovery records eligible, scanned, skipped, and reason counts plus a bounded skipped-path sample. These limits flow into scoring, coverage issues, dashboard disclosure, and an `ai_app_security` family receipt recorded in the checksummed result manifest; incomplete AI coverage cannot support a clean claim.
- A 217-file regression fixture proves Quick remains honestly bounded at 200 while still scanning vulnerable production code, and Standard evaluates all 217 files.
- At the time of that remediation, app `lyrashield-app--0000195`, scanner `lyrashield-scanner--0000176`, and egress proxy `lyrashield-egress-proxy--0000045` ran product `16a1fb7014ce3cbf9e56b69bff5074a5d0d8e0dd` at 100% traffic. CI `32966602739`, release `32967467190`, candidate/public smoke, worker promotion, post-recovery Docker health, and `/api/ready/scans` passed; this is historical deployment evidence.
- Production includes PR #432 Redis/egress efficiency and PR #450 secure scan-owned checkout recovery. The isolated billing test deployment and its runtime exception were retired on 2026-09-08 after the provider receipts were retained.

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

Runtime product `2d4e168da544306bf6cc9958a55f14bbfcb717e3` passed production release 40538483543 and independent worker/image/source/readiness checks. Controlled Standard and Deep PHP acceptance is recorded in §8 on its earlier image; a cold-cache Composer proposal and unchanged-source negative retest were subsequently observed, while the approval-bound PR and positive retest remain pending. Deployment, specific-fixture acceptance, customer runtime assurance and commercial readiness remain separate gates. The Desktop app has no signed release in this record.

### Local v26 implementation — 2026-10-30

The latest user instruction defers D5 and all landing motion/layout changes to preserve working production behavior. The candidate restores the five changed landing motion/runtime/layout files and existing motion browser tests exactly from main `284523ca381ee0d6ffa62ce22e855f7ecae9518f`. One static light-theme text-color accessibility fix in `EvidenceMap.astro` remains, with no motion or geometry change. Independent header/mobile-menu, CLI copy, claims and Turnstile fixes remain. No film regeneration, media change, production deployment or new loading-policy qualification is performed.

The approved local scope is integrated through `bacb2674b`, with final correctness repairs independently approved and landing preservation separately reviewed. Local core/targeted, database, operations, static and Chromium/WebKit browser proofs are source-qualified in the handoff, including 310 rendered cases and 80 axe scans with zero reported violations. The completed 34-scenario real-film comparison supports keeping existing motion; it establishes no D5 loading/smoothness improvement and preserves the positive native-cache-hit caveat. The final web build passed at `bacb2674b`; the exact-label worker-image receipt follows the documentation freeze. Exact-head remote CI and live/manual release qualifications remain outstanding. The [v26 source/disposition record](./docs/handoffs/v26-implementation-2026-10-30.md) preserves original issue IDs, intermediate local proofs and unperformed qualifications. This does not change §8's dated production evidence. Production cutover additionally requires the [admission/capacity runbook](./docs/operations.md#v26-admissioncapacity-cutover-and-compatible-rollback), including legacy drain, grants and a reservation-compatible rollback image. Routing/model selection is unchanged.

### Delivered features and bounded proofs

These are implementation or revision-scoped milestones, not a claim of universal, operational, or commercial readiness.

- Open registration, authenticated app origin, marketing site, passive Lite Scanner, and public tools.
- Core Target-to-Report loop in code.
- Bounded Standard/Luna production acceptance for the 2026-08-26 target and revision (scan evidence in §8); this is not a paid-scan acceptance of the 2026-10-01 deployment.
- Managed TLS BullMQ Redis and negative egress proof.
- Dedicated worker compute, immutable worker promotion, readiness heartbeat, and rollback image.
- The 2026-10-25 encrypted backup and exact-object isolated restore passed verified TLS, schema/migrations, audit and readiness, and published its public-safe proof; see the exact drill in §8.
- Billing code retains signed-webhook, replay, catalog-map, and disposable-account coverage. Restricted Polar Sandbox and Razorpay Test Mode proof completed in isolated Azure staging on product `5e6c68ba` under run `33438477364`, including hosted checkout, provider-delivered signed webhooks, application/database effects, replay idempotency, immediate cancellation, redacted receipts, and cleanup. Live charge, settlement, payout, tax, and universal payment-method coverage remain unproven.
- Read-only Brave provider review on 2026-08-26: Razorpay Live was activated with six matching INR Cloud plans and one enabled eight-event webhook. Polar Live had a production token, fifteen private Cloud/pack/Local products, and an enabled lifecycle webhook. That review performed no provider mutation or payment. Direct Azure readback after production release `34842662910` on 2026-09-14 found both Cloud purchase admissions `public` and both Local admissions `off`; no live charge, settlement, refund, or payout proof followed from that configuration.
- Cloud billing, usage, Local/Desktop, and affiliate implementations merged.
- The single adaptive dashboard and the bounded platform-admin console are implemented. Exact-two preflight/apply passed, and both named administrators completed fresh independent Google-plus-TOTP browser proof across every admin destination; bearer-only and workspace-only access remained denied.
- Production evidence-storage round-trip/fail-closed, actionable notification acknowledgment, terminal-cost disposition, queue-orphan recovery, and Key Vault managed-identity signing proofs passed.
- SEO/AEO/GEO foundations include canonical/schema metadata, sitemap and robots controls, dated `llms.txt`, `agents.md`, answer-engine crawler stanzas, integration guides, comparison/research pages, and content validation.
- Assurance hardening (PRs #428–#430) delivered nonnegative policy-budget enforcement, explainable deterministic finding priority, finding-detail evidence-URI redaction, worker execution provenance bound into manifests, fail-closed worker readiness, Azure alert provisioning, and a bounded host-side launch-assurance orchestrator. The current released source requires checksum `MATCH` for both stored manifests before deterministic retest validation. Current Azure readback finds those three reconciliation/catalog rules present and intentionally disabled under the October 12 noise policy. The operator receiver is verified and one controlled Azure test notification reached its inbox; individual alert-rule behavior remains unproven.
- The 2026-09-19 to 09-25 product waves are merged: delegated outbound connectors, scan attachments, the review-changes workflow with client parity, release-identity confirmation, the scan-quality surface, the authenticated-assessment staging beta, GPT-6 routing/accounting hardening and the Myra support launch behind feature flags. See the `codebase.md` ledger for the commit-level record.

### Remaining before broader paid/untrusted exposure

1. Refresh the report-only Polar/Razorpay reconciliation after the incomplete 2026-10-01 receipt, and retain a completed receipt/checkpoint without replay or baseline reset. Cloud billing flags being `public` is configuration evidence, not proof of live checkout, settlement, refunds, or commercial readiness.
2. Preserve the intentional disabled reconciliation/catalog rules and receiver configuration; one operator test notification was delivered, while individual rule behavior remains unproven. App and worker log ingestion are recorded separately in §8.
3. Read back the public scorecard canonical URL and OG image URL on the deployed revision. The canonical-origin code fix is already included in the deployed revision; the current evidence set does not include the page-specific live readback.
4. Retain longer-window Redis command/capacity evidence, verify RazorpayX and Payoneer payout access, and complete payout/tax operations before paid scale. The October 25 verified-TLS isolated restore and public-safe proof passed; retain fresh drills as the schema changes.
5. Triage the 25 findings from Standard scan `cmt9el7p7000001hdjnjo90wk` and obtain independent verification where warranted; keep unverified results `DETECTED` or `INCONCLUSIVE`.
6. Complete controlled PHP Composer approval-bound PR and positive retest acceptance after the required GitHub write workflow is verified. The controlled PHP Deep routing, usage, manifest and terminal proof is recorded in §8; it does not establish acceptance for another target or deployment.
7. Capture authenticated client-runtime acceptance and marketplace readback independently. CLI `0.2.14`, MCP `0.2.12`, and Agent Plugin `0.1.31` are published; matching immutable marketplace release and authenticated client-runtime acceptance remain outstanding, and no authenticated MCP workspace call was made during the current acceptance pass.
8. Capture webmaster indexing and answer-engine citation observations; code, simulated crawlers, and one LinkedIn unfurl do not prove universal discovery.

### Deferred

- Security Copilot sidebar and visual security plans/recaps.
- Compliance-lite evidence packs.
- IaC, container, cloud-account, and reachability scanning.
- Enterprise SSO/OIDC, SCIM, advanced policy, private worker, enterprise integrations, VPC/self-hosting, and data residency.
- Local/self-hosted model support.
- Human-validated pentest add-on.

### Known implementation and evidence debt

- GitHub installation ownership still needs provider-backed proof before binding a fresh installation; Fix PR execution still needs a server-generated immutable patch/evidence artifact bound to exact approval.
- Replace provider-managed object-encryption key references with an explicit KMS/Vault design when the evidence-storage provider is finalized.
- Complete AI-03 lockfile/advisory coverage, production triage provenance/accounting, private-score disposition carry-forward, report UX, and live calibration proof.
- New result manifests retain and hash their exact JSON checksum input; duplicate persistence, pending finalization and deterministic retest validation check stored integrity. These changes remain in deployed product revision `2d4e168da544306bf6cc9958a55f14bbfcb717e3` and worker digest `sha256:690bac6ed42d1c450af94055e270d5f21baa937771ba828e7e4871e501067fbe`. Historical rows with a null checksum input remain `UNAVAILABLE` and are not backfilled; no historical records were rewritten.
- The 2026-10-01 deployed retest finalizer did not require checksum `MATCH` for both the original and retest manifests before producing a validated outcome. No production receipt was audited to show an incorrect result. The fix shipped on 2026-10-10 and is included in deployed product revision `2d4e168da544306bf6cc9958a55f14bbfcb717e3`; keep legacy `UNAVAILABLE` evidence inconclusive and do not backfill or rewrite historical hashes.
- Current source and the 2026-10-11 release include durable delegated-operation outcome handling across grant rotation and reconciliation alert declarations. The October 11 readback found three missing alert rules and did not test receiver delivery; later evidence is recorded in §8.
- Restore or replace the removed historical AI-safety evaluation runner before claiming the recorded benchmark can be rerun from a clean checkout.

## 10. Founder decisions

- Trademark clearance for LyraShield AI and `lyrashieldai.com`.
- Confirm the intended current public Cloud-admission posture and authorize bounded live checkout/refund proof per rail; Local admissions remain off.

Decided 2026-09-22:

- Publish the existing Cloud and minute-pack prices unchanged. This decision does not authorize a new live charge, cancellation, or refund.
- Keep repository MCP/WebMCP findings visible on Trial and Starter; permissions and scan admission remain the control boundaries.
- Use the current production Deep profile for controlled acceptance on the fixed OnboardingAI2 revision; exact execution evidence remains a separate gate.
- Public release-identity confirmation is opt-in and capability-bound: a valid signed report plus its unexpired, unrevoked share token may confirm a caller-supplied commit or artifact digest as `MATCH`, `MISMATCH` or `UNAVAILABLE`. The API never returns the stored identity; unknown token, cross-report token, legacy provenance, checksum mismatch, expiry and revocation collapse to `UNAVAILABLE`; requests are rate-limited and non-cacheable.

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

See [docs/README.md](./docs/README.md) for the current document map, including [operator runbooks](./docs/operations.md) and retention rules.
