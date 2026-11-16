# LyraShield AI — Product Requirements and Release Plan

> Current production evidence: 2026-11-16 13:12 UTC — product `c651cc80c6eb5eb801a10df8661b210cbdd0ce48`, release `43862618892`, worker `sha256:cc26096d7e9283850b821f66808392734cf44385df0f9908c4258f42f8775bcd`, engine `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c`. See §8 for the published clients and earlier immutable paid/hosted acceptance identities. This file owns product strategy, accepted scope, release gates, and ordered backlog; running code, schema, CI, and live evidence override prose.

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
3. Agent-native distribution — CLI, MCP (22 tools), portable Agent Plugin, 51-entry registry / 48 preferred client surfaces, account-less GitHub Action (§2).
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
- monitor a target on a schedule (deferred from the current launch offering; see §9);
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
- BullMQ scan admission, queueing, preflight, target serialization, lifecycle events, cancellation, orphan reconciliation, and fail-closed worker readiness. Schedule creation and enabling are disabled for the launch; stored schedule rows are preserved (§9).
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
- A gated authenticated-assessment staging beta for authorized scope checks. Its admission stays off for the launch and stored assessments are preserved (§9).

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
- `WEB_APP`: Safe and Quick use deterministic URL checks only. The Standard and Deep/Custom engine-backed profiles remain in source and require domain verification and a scan-scoped relay grant, but they are removed from the launch offering (§9).
- `API`: Safe and Quick use deterministic OpenAPI checks only. The Standard and Deep/Custom engine-backed profiles also require a validated public HTTPS spec URL and are removed from the launch offering (§9).
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
- URL/API Safe/Quick have zero AI budget. The Standard/Deep/Custom URL/API equivalents select GPT-6 Luna with a $3.20 provider cap and GPT-6 Sol-root/Luna-specialist routing with a $5 cap respectively, and are removed from the launch offering (§9). These are source profile contracts, not completed live scan acceptance. The remote relay rejects opaque CONNECT tunnels; a sandbox-local TLS adapter converts HTTPS client traffic into inspectable requests using the installed sandbox CA. Composed local curl and Chromium navigation/fetch acceptance passed allowed requests and denied path/method/redirect requests without TLS bypass, including rejection of an invalid upstream certificate. Exact-image production deployment and a paid URL engine scan remain unverified.

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

### Coordinated client release — 2026-11-16 13:12 UTC

[PR #1148](https://github.com/ecryptoguru/lyrashield-ai/pull/1148) merged as `c651cc80c6eb5eb801a10df8661b210cbdd0ce48` after all three required checks passed on exact head `36f6c7c0d9f6ada1dcc4d27495005c7d8352b06d` ([CI 43860099222](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43860099222)). [Release 43862618892](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43862618892) passed source qualification, exact-image rehearsal, Azure rollout, worker promotion and marketing deployment. Independent readback confirmed:

| Component    | Revision / source                                         | Image digest                                                              |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| App          | `lyrashield-app--0000524`, healthy, 100%                  | `sha256:8efef1faafca8ab6dda634cd60e670e855eb20076e7627084850ec1ed34a1aff` |
| Scanner      | `lyrashield-scanner--0000498`, healthy, 100%              | same web digest                                                           |
| Egress proxy | `lyrashield-egress-proxy--0000364`, healthy, 100%         | `sha256:0e397fae3295c650cfcee004fd9b0f303d0ef80859c20912d12127dd80d2f44b` |
| Worker       | product `c651cc80c6eb5eb801a10df8661b210cbdd0ce48`        | `sha256:cc26096d7e9283850b821f66808392734cf44385df0f9908c4258f42f8775bcd` |
| Engine       | unchanged `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c`      | bound in worker provenance                                                |
| Marketing    | homepage build `c651cc80c6eb5eb801a10df8661b210cbdd0ce48` | Cloudflare deployment                                                     |

App health, scanner readiness and scan readiness returned 200. The preceding app/scanner/proxy revisions remain at 0% traffic. Standard/Deep receipts below still verify `MATCH`, each with exactly one unchanged account-owned usage receipt; their original product revision remains `637a178ae`, not this client release.

Public npm latest is MCP `0.2.13`, Agent Plugin `0.1.32` and CLI `0.2.15`. Downloaded SHA-256 and npm integrity match the reviewed archives from source `a64713f93af3ccf77771e6ea4ced6e0cc671f4a3`; subsequent source changes were documentation only. A fresh public consumer passed MCP discovery of 22 tools, setup-health, sealed quality reads and CLI resume of existing deterministic URL scan `cmwiqcx4x000901k576f3xqfx`, without new execution or usage. Local verification passed 767 focused tests across 69 files, package typechecks, ESLint, packed runtime checks and size gates. MCP adds the missing setup-health tool; the CLI supplies Node's standard ESM `createRequire` to repair its scan-loader failure. Exact pins reach the SDK/MCP/plugin/CLI, WebMCP adapters, client guides and generated marketplace templates without changing support tiers or transports.

Immutable marketplace publication, individual native client activation, physical-device/screen-reader, financial and broker-authority qualification require separate receipts. No additional paid scans were run for this client release; prior hosted acceptance is bounded to the source identities below.

### Hosted acceptance and client provenance — 2026-11-16 03:55 UTC

[PR #1147](https://github.com/ecryptoguru/lyrashield-ai/pull/1147) merged as `679021c069789ad2060f60d38b1d8261fd56b9d6` after all three required checks passed on exact head `767563520fa13cf54404a0962e5f733168d16f79` ([CI 43794901096](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43794901096): 10,220 core tests passed, 387 skipped; 49 browser and 289 portable-browser checks passed). [Release 43796371038](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43796371038) succeeded. Independent readback confirmed app `0000523`, scanner `0000497` and proxy `0000363` healthy at 100%; web digest `sha256:7ce12256fbfaa1bf930f9cc82fa31dd2940679bd033fb95bff34a5366ab34694`, proxy digest `sha256:a7954502dadfc589965d437f300d85b511ca344c01b59090a1c7d36733c17221`, worker digest `sha256:2bbe9ace4dead4f92f07198c039a6adc40a70baacd53aeff36dd65196b49432b`, product `679021c069789ad2060f60d38b1d8261fd56b9d6` and unchanged engine `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c`. App health, scanner readiness and scan readiness returned 200.

The founder-authorized fresh Standard and Deep scans ran before this client repair, on the then-current deployed product `637a178ae589a4545224afb1e13c4b694fefd679` and worker `sha256:138d435fd5b17d819bd8136ec43d8d0856434f0d93067bd9275c15749d44ea70`, against OnboardingAI2 revision `8e854ab9eba4526f2cfeb9d6bdfe7884ba5af4fe`:

| Profile  | Scan                        | Elapsed    | Model requests | Agent-minutes | Manifest SHA-256                                                   |
| -------- | --------------------------- | ---------- | -------------- | ------------- | ------------------------------------------------------------------ |
| Standard | `cmwimj28q000b01fulxtbij96` | 15m21.656s | 295            | 16            | `6b5c1bb56ed83436b1fad8d34295792b72e0de8ce6e03e7f4b7cc4193df3fe66` |
| Deep     | `cmwin4r8f000i01fu4y3p7kaf` | 12m17.052s | 340            | 39            | `5fb938730101232f06ba13b5596b39d5069a3621f2ff577c618803ff4b6f80b0` |

Both completed with checksum `MATCH` and exactly one account-owned usage receipt each. The Standard idempotency replay returned the same scan and operation. The dependency inventory remains incomplete at the unchanged limit of 500; completion does not establish full coverage. An operator mistakenly selected repository SAFE for a later proof scan; it aliases model-backed QUICK. Scan `cmwiq9ncc000201k52u8rnmjd` was cancelled after about a minute, retaining 17 model requests and one 2-minute usage receipt. Added consumption is 16 + 39 + 2 = 57; total use is 123 of 4,500, leaving 4,377. No live checkout/refund or billing-system acceptance was performed.

The shared repair binds ordinary OAuth admission's existing authenticated operation proof into the immutable scan provenance and returns `connect_required` for hosted API-key mutations. New deterministic URL SAFE scan `cmwiqcx4x000901k576f3xqfx` completed in 2.295s on product `679021c069789ad2060f60d38b1d8261fd56b9d6`, with native operation `cmwiqcwyq000801k59ha3b8an`, matching stored authorization-plan hash and manifest `01c0d96a6f9d9398d662ac496a46565f5f5ee7e8cfbb87da3fae70571486561a` (`MATCH`). Hosted MCP full quality read succeeded. No model execution or usage receipt exists for this URL scan. Historical scans missing original provenance remain restricted; no backfill weakens the boundary. SDK, CLI, MCP, WebMCP and plugin source compatibility checks passed (190 tests).

Hosted tenant/credential qualification passed 20 assertions: a temporary read-only key could read only its workspace, including when its real owner belonged to both workspaces; foreign scan reads and scoped database reads disclosed nothing; REST writes/key management were denied; MCP reads worked and mutations returned `connect_required`; deactivated creator membership and revoked keys were rejected by REST and MCP. No denied mutation created a scan or usage. The individual target GET endpoint is unsupported (405), and is not counted as a tenancy proof. The temporary key was revoked and workspace archived, with lifecycle audit events.

Public report sharing passed 11 assertions on report `cmwimm3vu000f01fuj7yjhby7`: valid anonymous minimal projection, absent private execution/storage/credential fields, refusal of missing/wrong/cross-report tokens, immediate revocation including conditional requests, and retained owner access. The token existed only in process memory and was revoked. No production scorecard was created.

A packed CLI scan-resume check found `Dynamic require of "assert" is not supported`; the CLI ESM banner now supplies Node's standard `createRequire`. The repaired bundle successfully resumed the same URL scan without creating another scan. CLI `0.2.15` is published; its public tarball matches the reviewed archive. Published MCP `0.2.12` reads the same scan quality but exposes 21 tools and lacks the current setup-health tool. Published coordinated MCP `0.2.13`, Agent Plugin `0.1.32` and CLI `0.2.15` update the tool catalog and exact client pins. Public latest versions are `0.2.13` / `0.1.32` / `0.2.15`, with exact SHA-256 and npm integrity readback. This publication receipt does not establish a product rollout or immutable marketplace release.

Broker authority (#7) remains deferred and unqualified. Physical-device/screen-reader, individual IDE/native marketplace activation and financial qualification are outside this bounded acceptance. These receipts supersede earlier pending paid, tenant/credential and report-sharing statements; they are not universal launch qualification.

### Current deployed production — 2026-11-16 record (released 2026-11-15 22:16 UTC)

> Earlier release tuple; the later deployed tuple and acceptance receipts above supersede its pending qualification statements.

[PR #1143](https://github.com/ecryptoguru/lyrashield-ai/pull/1143) merged as `637a178ae589a4545224afb1e13c4b694fefd679` after `SCA & Secret Scan`, `Lint, Typecheck, Test & Build` and `Pinned Engine / Worker Contract` passed on its exact head `acf00c1e4875666ff5b22c6bc031210a034b2ba4`. [Release 43764099383](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43764099383) succeeded end to end: source qualification, exact-image build, disposable worker rehearsal, production migration preparation, Container Apps rollout, marketing deploy, worker promotion and smoke. The optional `queue` check failed on that head; it is a known optional failure and is not relabeled successful.

This release closes the three gaps recorded in the 2026-11-16 independent verification, plus restore-failure visibility:

- `GET /api/fix-proposals` derives `hasPatchBase` from the nested finding base commit, so a valid proposal loaded through pagination keeps its pull-request action.
- A deterministic-retest baseline refusal is classified terminal before execution as `RETEST_BASELINE_UNAVAILABLE` (`apps/worker/src/jobs/run-scan/terminal-failure.ts`): the inconclusive receipt is retained, no provider execution or agent-minutes are charged, no queue attempt is consumed, and the scan detail offers a baseline recovery action instead of an internal failure.
- `PATCH /api/targets/[id]` accepts `installationId` for repository targets and rebinds only to an active `GITHUB` integration of the same workspace that proves access to the exact repository (`apps/web/src/lib/target-installation-rebind.ts`), auditing `target.github_installation_rebound`. The target page offers the connection choice or a link to connect GitHub.
- Failed `backup` and weekly `restore` drill runs write a public-safe failure summary and an `::error` annotation instead of failing silently.

An independent Azure and VM readback at `2026-11-15T22:16:36Z` confirmed the deployed tuple:

| Surface      | Revision                                                                                      | Identity                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app          | `lyrashield-app--0000521` (100% traffic, Healthy)                                             | web digest `sha256:a6519ad2405396ead775d8290640a7b3ed149c60d185c9c9cd7513ebe24d5126`                                                                                                   |
| scanner      | `lyrashield-scanner--0000495` (100% traffic, Healthy)                                         | same web digest                                                                                                                                                                        |
| egress proxy | `lyrashield-egress-proxy--0000361` (100% traffic, Healthy)                                    | proxy digest `sha256:695a12e102dfedea1aff0a812f72c80b35f761af87f6eb086e93afc083211fb5`                                                                                                 |
| worker       | `lyrashield-worker` VM, active since `2026-11-15T22:14:46Z`, container healthy, zero restarts | image `sha256:138d435fd5b17d819bd8136ec43d8d0856434f0d93067bd9275c15749d44ea70`, product `637a178ae589a4545224afb1e13c4b694fefd679`, engine `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c` |
| marketing    | Cloudflare deploy from `637a178ae`                                                            | homepage serves build revision `637a178ae589a4545224afb1e13c4b694fefd679`                                                                                                              |

All revisions use the product tag `637a178ae`. The superseded revisions (`0000520`, `0000494`, `0000360`) are retained at 0% traffic for rollback.

Public probes at `2026-11-15T22:16:36Z`: `https://lyrashieldai.com/` 200, `https://app.lyrashieldai.com/api/ready` 200 (`database`, `redis`), `https://app.lyrashieldai.com/api/ready/scans` 200 (`worker: true`), `https://scanner.lyrashieldai.com/api/ready` 200. The scan admission stop key `lyrashield:scan-admission:stopped` was absent (`EXISTS` = 0) and the scan queue was empty in wait, active, failed, delayed, prioritized and paused states.

Recorded honestly: `/api/ready/scans` returned `503` `{"status":"not_ready","checks":{"worker":false}}` earlier in the same rollout, while the worker was being promoted. That is a real planned window in which new scans were refused (`codebase.md` §11 documents it as the controlled promotion stop); it was not unexpected unavailability, and it cleared when promotion finished.

This is a deployment fact only. It does not establish authenticated customer journeys, paid model-backed scan acceptance on OnboardingAI2, physical-device or screen-reader qualification, or any financial readiness. D5 remains deferred. No scorecard, public sharing or paid acceptance follows from this release. The separate deterministic fix-and-retest receipt below was observed on this tuple; it is not a paid model-backed acceptance.

### Fix PR and deterministic retest acceptance — 2026-11-16

The first positive end-to-end remediation receipt observed on deployed production (`637a178ae`), in workspace `cmrtq1zdx00000124rxffgrlg` against fixture target `cmvnlqpvv000001kre6dvf24g` (`ecryptoguru/lyrashield-php-acceptance-20261025`, branch `main`):

- Originating scan `cmvqrksed000101mb5r5v9gcz` ran SAFE and deterministic on 2026-10-27 at revision `901f928a82a9bdbfea457870bf242599eebcb627` with result-manifest `73a08eaf86e5eaa675669cb86241cadffe2626dad08c8a3a200f91cfda162e08`, and recorded 15 findings, all `DETECTED`. Coverage receipts: `sca`, `secrets`, `agent_config`, `ml_supply_chain` and `ai_app_security` `COMPLETED`; `sast` and `iac` `BLOCKED`.
- Finding `cmvnr1oa700140nx3viidm6s2` — `symfony/process@6.4.32`, GHSA-r39x-jcww-82v6 / CVE-2026-24739, CWE-88, MEDIUM.
- Proposal `cmvqrgyph000001mb88l5t2pz` (`composer_update`) carried a stored server-generated patch raising only `symfony/process` from 6.4.32 to 6.4.33.
- `lyrashield_request_fix_pr` (approval `cmwikr6nc000101fu3e5ky1ow`) opened [pull/1](https://github.com/ecryptoguru/lyrashield-php-acceptance-20261025/pull/1) as a draft containing one file, `api/composer.lock`; the fixture owner marked it ready and squash-merged `30b4d018e1d4abbb69c311008a664b4a36ebe975`.
- `lyrashield_verify_fix` queued retest `cmwiksnx9000701fulm5c4pgy` → scan `cmwiksnuo000501fu43qj89bx`, SAFE and deterministic, `2026-11-16T01:19:26.144Z` → `01:19:35.435Z`, result-manifest `97b93c4f5597c75eefac4eecca3c3205d44b2fa0ae179d85b78eef2dd09e1513`, receipt revision `30b4d018e1d4abbb69c311008a664b4a36ebe975`, coverage shape matching the originating scan.
- Receipt: status `FIXED`, verification `VALIDATED`, method `RETEST`, reason “The originating deterministic scanner did not detect the finding in the queued retest.”, `fixedAt 2026-11-16T01:19:35.299Z`. Both scans report `llmRequests: null`, so no model usage and no agent-minutes were charged.

This proves the deterministic chain server-generated patch → GitHub PR → merged revision → retest → `VALIDATED`, with both scans bound to stored manifests and exact repository revisions.

It does not prove a paid model-backed Standard/Deep acceptance: `sast` and `iac` coverage is `BLOCKED` on this fixture, so findings from those families cannot reach `VALIDATED` here. Hosted tenant, credential and MCP acceptance beyond the calls above, physical-device and screen-reader qualification, and any financial readiness remain open.

Delegated-read scope was also confirmed in passing: a hosted MCP connection reads only scans it created (`getDelegatedScanAccess` binds `Scan.delegatedConnectionId`), so `lyrashield_get_scan_status` returns `Scan not found` for the dashboard-created originating scan while the connection-created retest scan is readable. That is least-privilege behaviour, not a missing scan.

### Controller integration release and production hold — 2026-11-14

The candidate pins merged engine `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c` ([engine PR #240](https://github.com/ecryptoguru/lyrashield-engine/pull/240), [engine PR #242](https://github.com/ecryptoguru/lyrashield-engine/pull/242)): the root producer builds the canonical SDK manifest and controller attachment consumes the same bytes, and signed attach-only sandbox execution binds the confirmed ownership and immutable attempt. The broker, supervisor and provider-gateway images were published from `6d080c5e163e72702156dc330a5212a425299e8b` ([PR #1127](https://github.com/ecryptoguru/lyrashield-ai/pull/1127)), but no qualification, installed production authority, authenticated fleet/journal evidence or compatible rollback tuple exists, so that path stays **HELD** and closed to production. The worker selects `existing-production-baseline` when no broker installation exists and fails closed on an unverifiable one; disposable Linux tests cannot authorize production SDK grants. Source wiring and the bounded local test counts are retained in git and `codebase.md` §11.

### Release path restored — 2026-11-15

Normal releases flow main push → `release-production.yml` → `deploy-azure.yml`: source qualification against the merged PR's required checks, exact-image build, disposable rehearsal, guarded Azure rollout with smoke and traffic rollback, and worker promotion; marketing deploys independently. The retired fleet-issuer lane (issuer workflows, cold-release scripts/probes/tests and the sandbox SBOM-coverage consumer) is deleted. The paired preflight is opt-in on a founder-supplied qualified digest, and the retained-worker and webhook-recovery lanes keep their holds. Paid model-backed Standard/Deep repository scans remain enabled by design; OnboardingAI2 remains the controlled-acceptance fixture.

### Current deployed production — 2026-11-15 (recovery release; superseded 2026-11-16 record)

[Release 43700283334](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43700283334) deployed `9faf5a903090525cfcbc43dde3abd1bc7cedb2db` after the same gates and promoted app `lyrashield-app--0000516`, scanner `lyrashield-scanner--0000490` and egress proxy `lyrashield-egress-proxy--0000356` to 100% traffic, with worker `sha256:c9ecd28042fd0e607b2f7ba7f08d9feb4d4daf1c1d964883291e48dae9e10c07` and readiness 200.

Two migrations failed first because production's pgcrypto lives in the `extensions` schema rather than `public`: compat migrations #1134 and #1135 supply the ordered, idempotent `public.digest` shim, both failed attempts were marked `rolled_back`, and the rerun applied cleanly with no schema rollback or data change. Superseded by the 2026-11-16 record above.

### Current deployed production — 2026-11-02 21:04 UTC (superseded)

[Release 41518076035](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/41518076035) deployed `b03f0bbe2b42f3a49e24e103655187372ba0a5f6` ([PR #1070](https://github.com/ecryptoguru/lyrashield-ai/pull/1070)); app `0000515`, scanner `0000489` and proxy `0000355` were healthy at 100% traffic on web digest `sha256:b6bc5a4dab854a1949342808659ec79ff9d74d4bf1da71967ba1e012c1825726` and proxy digest `sha256:272b72d1c81f87d94348caed86bda0dd5ba0c80500252ba9f0989080b786de4c`, with a healthy worker on `sha256:9e942d0564e849d9c453b301bd5a88b1a35d8b326ba7791149bdf95048f96ad3` and engine `3001517530300ca5f602536bfadcbd3c95ad3039`. The deployed source was 396 commits behind main at the 2026-11-14 readback, so it predates the retained launch scope. Superseded.

### Controller integration local verification — 2026-11-13

Local broker, supervisor and gateway plumbing (transaction-fenced preparation, signed journals, receipt staging, admission stop, inventory verification) passed its bounded suites and disposable database tests. No qualified launcher, installed host-policy/image tuple, protected journal or production execution authority was installed, so none of it authorized production execution. The detailed counts and test names remain in git.

### Cloud launch checkpoint — 2026-11-12

Product main was `9a49ad9a91b7b04bf789eb0d5e12d9e8addc9e56`; [release 43260482617](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43260482617) built the images and passed the disposable rehearsal but skipped promotion because no qualified digest was supplied. The remaining Cloud launch requirements are owned by §9.

### Nonbilling production release — 2026-11-02 IST

[Release 41438792830](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/41438792830) deployed `d488862bd269c07194afe87a918ca413e4a62217` (PR #1066 with #1067) at web digest `sha256:155deca0b118249ab8590d87563bf0cffe839d15809bbb56dfceb4799843fc76`, proxy `sha256:54f29c5b5502e03a0a3842ef454798b2565248b27ce0bc9c7ca8232a2bce3172` and worker `sha256:c84fe0c97554bd4003f005f86d0041b29c8cbf2cefcd0ebe038956bbf05293c0`; marketing source was unchanged from `0d8fc0f6c126271aa966ca895608cec2460f8cb4`. The November 1 scheduled restore failed row-integrity verification with its private logs already cleaned, so the cause remains unknown; the owner-requested [isolated restore 41448546391](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/41448546391) later passed exact-object, row, schema, audit, readiness and cleanup. Superseded.

### v26 production addendum — 2026-10-31 IST

[Release 41117355986](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/41117355986) deployed `6739563df7dad585cef1be14cedcb978bc0a5219` after a first cutover failed before migration and was restored through the exact owned-stop abort; preserve that failed receipt. Readback recorded receipt `COMPLETE`, four migration checksums, forced RLS on both new tables, app/scanner at `sha256:c73a978d3c9de1efa93b87e0e8524e775fa54cc1b627b8137a043541b7ce385b` and worker `sha256:33a769654ba9c68116d07b4986da673d95d38ed58c8be8369cdc33895d78e723`. Marketing preservation, original-ID dispositions and unperformed qualifications were recorded in the v26 handoff (`docs/handoffs/v26-implementation-2026-10-30.md`, removed 2026-11-16; recover from Git at `c07b91203` or earlier). Remaining qualifications are owned by §9. No financial or loading-policy conclusion follows.

### Historical PHP release and production readback — 2026-10-27

[Release 40538483543](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40538483543) deployed `2d4e168da544306bf6cc9958a55f14bbfcb717e3` (PR #1043) with healthy worker `sha256:690bac6ed42d1c450af94055e270d5f21baa937771ba828e7e4871e501067fbe` and engine `3001517530300ca5f602536bfadcbd3c95ad3039`. Controlled Standard `cmvnqwadx000101ly0gzgje7w` (4m19s) and Deep `cmvnr3qd9000401lyejnwjg8c` (11m43s) PHP scans completed on the earlier `d62303b1` worker with checksum `MATCH` manifests at fixture revision `901f928a82a9bdbfea457870bf242599eebcb627`: 15 findings each, all nine vulnerable source cases detected, all nine safe controls and the patched runtime excluded, bounded SAST and runtime identity explicitly incomplete. That is fixture-scoped evidence, not universal accuracy. A later cold-cache Composer proposal was sealed and an unchanged-source negative retest correctly left the finding OPEN/DETECTED.

### Recovery and monitoring readback — 2026-10-27

The October 25 [isolated restore 40172080687](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40172080687) passed verified TLS, exact-object, schema/migrations, audit, readiness, cleanup and public-safe proof. Three reconciliation/catalog alert rules remain intentionally disabled under the October 12 noise policy; the operator receiver is verified and one controlled Azure test notification reached the inbox, which does not prove individual rule behaviour.

### Previous production release — 2026-10-10

[Release 38082773161](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/38082773161) deployed `41462a3ff45f77e996823faf6d10f56053dec9e8` with worker `sha256:91203cb94795cc8ae143e4a07da86a2fc3eac5e38ed1ebc862e46c1333d55007` and engine `3001517530300ca5f602536bfadcbd3c95ad3039`; scan readiness returned 200 at `2026-10-10T20:53:34Z`. Release and scan-admission evidence only.

### Historical production release — 2026-10-01

[Release 36908006265](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36908006265) deployed `4822306e24f375800981bf282fd992a9c15dcde8` with web `sha256:dbc43686e11f95a03d9f163c865683e3949ade4179839ef6d268e6ea55f9b78f`, proxy `sha256:2951a50935f458c16495ccee9005990b2d4a5ba0a5470be1922a90733729bd24`, worker `sha256:d38f8b080ae62b88ba9c6273be76abff42adf5a86b831bde5b19f6d6fce466dc` and engine `9d90be5aaf92f86bb5c1ba55a8138545764fdd44`; readiness returned 200. Release and scan-admission evidence only.

### Operational blockers last verified 2026-10-01

- The report-only Polar/Razorpay reconciliation is still incomplete: a Polar `insufficient_scope` 403 left a receipt with zero orders checked and no newer completed receipt recorded. Fix the grant, rerun report-only reconciliation, and do not replay events, reset the coverage baseline or infer coverage from zero counters.
- The release sync copies the app's Polar credential into worker Key Vault, so a worker-only replacement is overwritten by the next release. Correct the source-of-truth provider grant, then use the guarded refresh/promotion path.

### Standard/Luna acceptance — 2026-08-26

Scan `cmt9el7p7000001hdjnjo90wk` on `ecryptoguru/OnboardingAI2@1689f3607d68764e09769535df8e368c4d5ad2fe` completed in 10m 9s with 189 `azure_ai/gpt-5.6-luna` medium requests, no Terra, 8,549,456 input / 6,535,778 cached / 32,092 output tokens, `$0.578800` under the `$3.20` cap, 10 Standard agent-minutes, 25 findings (17 `DETECTED`, 8 `INCONCLUSIVE`, zero independently verified), manifest v5 `ebfa3fb0ba19d97d8d9393432f8dbe37078b4bcf0367a7b91c21fe54a78e5687`, and completed engine/SCA/secrets/agent/ML/AI-App-Security coverage. AI App Security scanned 217/217 eligible files and 1,956,360 bytes with zero skips. Bounded runtime, routing, accounting and terminal proof for that target and revision only.

### Historical AI App Security coverage remediation — 2026-08-21

PR #386 keeps the earlier bounded scan unchanged and corrects future coverage: production/config sources rank first, generated artifacts are excluded, mode caps are 200/500/1000 files with byte, time, depth and entry bounds, and discovery records eligible/scanned/skipped/reason counts plus a bounded skipped-path sample. Those limits flow into scoring, coverage receipts and the scan-detail UI, so incomplete AI coverage cannot support a clean claim; a 217-file fixture proves Quick stays bounded at 200 while Standard evaluates all 217.

## 9. Release status

Cloud launch is not yet qualified. Production runs `c651cc80` (§8); the Desktop app has no signed release. The controller/broker admission path stays closed until installed production authority and protected journal evidence exist. Controlled Standard/Deep, deterministic Composer fix/retest, hosted tenant/credential/MCP and temporary report-sharing receipts pass within their recorded scope. Coordinated MCP/plugin/CLI publication and public consumer checks pass; immutable marketplace publication, individual native client activation, physical-device/screen-reader and financial qualification require separate receipts.

### Delivered features and bounded proofs

These are implementation or revision-scoped milestones, not a claim of universal, operational or commercial readiness.

- Target-to-report loop, dashboard, admin console, marketing site, passive Lite Scanner, public tools, CLI/MCP/plugin, billing, usage, Local/Desktop and affiliate code are merged; both named administrators completed independent Google-plus-TOTP browser proof, and bearer-only or workspace-only access remained denied.
- Bounded Standard/Luna production acceptance for scan `cmt9el7p7000001hdjnjo90wk` (§8), managed TLS BullMQ Redis with negative egress proof, immutable worker promotion, readiness heartbeat and rollback image.
- Signed-webhook, replay, catalog-map and disposable-account billing coverage. Restricted Polar Sandbox and Razorpay Test Mode proof completed in isolated Azure staging on `5e6c68ba` under run `33438477364`, including hosted checkout, provider-delivered webhooks, database effects, replay idempotency, cancellation, redacted receipts and cleanup. Live charge, settlement, payout and tax remain unproven.
- Production evidence-storage round-trip and missing-KEK fail-closed, queue-orphan recovery, Key Vault managed-identity signing, encrypted backup with isolated restore, and alert provisioning with operator acknowledgment.
- Assurance hardening (PRs #428–#430): nonnegative policy budgets, explainable deterministic finding priority, evidence-URI redaction, worker provenance bound into manifests, fail-closed worker readiness and a bounded host-side launch-assurance orchestrator.
- SEO/AEO/GEO foundations: canonical and schema metadata, sitemap and robots controls, dated `llms.txt`, `agents.md`, answer-engine crawler stanzas, integration guides and comparison/research pages.

### Remaining before broader paid/untrusted exposure

The items below include one-time business obligations, historical triage and operational follow-up; webmaster indexing observations and later payout/tax work are not recurring software release gates. Keep essential monitoring and backup drills. Historical findings require triage before they become confirmed defects.

1. Refresh the report-only Polar/Razorpay reconciliation after the incomplete 2026-10-01 receipt, and retain a completed receipt/checkpoint without replay or baseline reset. Cloud billing flags being `public` is configuration evidence, not proof of live checkout, settlement, refunds or commercial readiness.
2. Preserve the intentionally disabled reconciliation/catalog rules and receiver configuration; one operator test notification was delivered, while individual rule behavior remains unproven.
3. Read back the public scorecard canonical URL and OG image URL on the deployed revision. The canonical-origin fix is deployed; the page-specific live readback is not in the evidence set.
4. Retain longer-window Redis command/capacity evidence, verify RazorpayX and Payoneer payout access, and complete payout/tax operations before paid scale. Retain fresh restore drills as the schema changes.
5. Triage the 25 findings from Standard scan `cmt9el7p7000001hdjnjo90wk` and obtain independent verification where warranted; keep unverified results `DETECTED` or `INCONCLUSIVE`.
6. Complete paid model-backed Composer acceptance. The deterministic SCA fix-and-retest chain is recorded in §8 (2026-11-16); `sast` and `iac` findings cannot validate on that fixture, and no other target or deployment is covered.
7. Capture authenticated client-runtime and marketplace acceptance. Fix-PR, retest and status reads succeeded through hosted MCP during the 2026-11-16 run; matching immutable marketplace release and full client-runtime acceptance remain outstanding.
8. Capture webmaster indexing and answer-engine citation observations; code, simulated crawlers and one LinkedIn unfurl do not prove universal discovery.

### Deferred

- Security Copilot sidebar and visual security plans/recaps.
- Compliance-lite evidence packs.
- IaC, container, cloud-account and reachability scanning.
- Enterprise SSO/OIDC, SCIM, advanced policy, private worker, enterprise integrations, VPC/self-hosting and data residency.
- Local/self-hosted model support.
- Human-validated pentest add-on.
- Scheduled scans and authenticated assessments, with their stored rows preserved. See [`docs/Phase2.md`](./docs/Phase2.md#launch-scope-deferrals--2026-11-13).
- URL/API Standard, Deep and Custom profiles, removed from the launch offering; URL/API launch retains deterministic Safe and Quick only, and their return needs a future explicit product decision.
- Advanced sandbox capabilities that retained repository execution does not invoke.

### Known implementation and evidence debt

- Current source requires provider-backed GitHub installation ownership proof and a stored server-generated patch bound to the finding, proposal, scanned base and exact approval before Fix PR execution. The remaining task is paid provider-backed acceptance, not implementation of those checks.
- Replace provider-managed object-encryption key references with an explicit KMS/Vault design when the evidence-storage provider is finalized.
- Complete AI-03 lockfile/advisory coverage, production triage provenance/accounting, private-score disposition carry-forward, report UX and live calibration proof.
- New result manifests retain and hash their exact JSON checksum input; duplicate persistence, pending finalization and deterministic retest validation check stored integrity. Historical rows with a null checksum input remain `UNAVAILABLE` and are not backfilled.
- The 2026-10-01 retest finalizer did not require checksum `MATCH` on both stored manifests before producing a validated outcome. The fix shipped on 2026-10-10 and is retained; no production receipt was audited to show an incorrect result, and legacy `UNAVAILABLE` evidence stays inconclusive with no backfill or hash rewrite.
- Durable delegated-operation outcome handling spans grant rotation and reconciliation alert declarations; the October 11 readback found three missing alert rules and did not test receiver delivery.
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
