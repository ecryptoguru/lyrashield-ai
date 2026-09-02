# AGENTS.md — LyraShield AI handoff

Read this first. [PRD.md](./PRD.md) owns product scope and release gates. [codebase.md](./codebase.md) owns architecture and code mapping. Running code, Prisma schema, migrations, CI, and live evidence override documentation.

## Product and repositories

LyraShield AI is an evidence-backed release-assurance layer for AI-built software:

```text
Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report
```

One product, two modes:

- Cloud: hosted subscription; LyraShield pays model cost.
- Local/Desktop: BYOK licensed app; customer supplies model credentials; optional Cloud Sync.

Repository ownership:

- this repo: product, web/API, worker orchestration, deterministic scanners, billing, licenses, affiliates, MCP/CLI/plugin, desktop, and marketing;
- sibling `lyrashield-engine`: controlled Python engine;
- sibling `lyrashield-marketplace`: generated public install artifacts.

Public name: **LyraShield AI**. Canonical domain: `lyrashieldai.com`. Do not rename `@lyrashield/*` or `LYRASHIELD_*` without founder approval.

## Current verified state — 2026-09-02

- Open beta with open registration at `https://app.lyrashieldai.com/sign-up`; never call it pre-launch or a waitlist.
- Marketing, passive Lite Scanner, authenticated app origin, Cloudflare bindings, TLS, sitemap/robots/`llms.txt`, security headers, and open-registration CTAs are live.
- Core Sprints 0–10 are merged: auth/tenancy, scan pipeline, findings/evidence/retests/reports, notifications/schedules, scorecards/referrals, agent/MCP/CLI/plugin, Polar/Razorpay billing, Local/Desktop, and affiliates.
- The launch-assurance wave (WP1–WP7) and Deep Review v14 remediation are merged (main `ae205163`): WP1 two-line repricing (Scan: Trial/Starter/Pro; Launch Assurance $499 self-serve, Enterprise from $1,500 contact-led; failed scans never billed), WP2 Launch Gate (`lyrashield-gate/1.0.0`, append-only `GateVerdict` under RLS, verdict refreshed after every terminal scan state), WP3 fix-PR pipeline fully wired (deterministic `fix-generate` producer, `baseCommit` stamping, real retest loop-closure on merged fix branches), WP4 signed shareable Launch Readiness Report (allowlisted payload, ed25519, public verify), WP5 CLI `gate --verdict` (exit codes 0/1/2), WP6 AI-Built Failure Taxonomy (public at `/api/taxonomy/ai-built-failures`), WP7 WebMCP-11/12 (embedded-secret and prompt-injection-surface detection). v14 also fixed: uncovered-target-types never READY, GateVerdict RLS + WORKSPACE_SCOPED_MODELS, honest medium/low disclosure in launch reports, fail-closed patch scope (PRO+ only get implicated-set/200), engine stream-tail capture on failed runs, eligibility preflight/POST parity, and CI rollback resilience. The engine worker pin is advanced to web `ae205163` (engine `2c8fccc`).
- Engine version 1.2.1 over pinned Strix v1.5.3. Safe/Quick/Standard use Luna/medium; Deep/Custom use Terra/medium root plus Luna/high specialists. Caps: $1.20/$1.20/$3.20/$5/$5.
- Current Standard acceptance: scan `cmt9el7p7000001hdjnjo90wk`, `OnboardingAI2@1689f3607d68764e09769535df8e368c4d5ad2fe`, completed in 10m 9s. All 189 requests used Luna/medium; the per-request model buckets and engine total reconciled to $0.578800 under the $3.20 cap; 10 Standard minutes were debited at 1×; 25 findings were retained; zero were independently verified.
- The current acceptance sealed manifest v5 checksum `ebfa3fb0ba19d97d8d9393432f8dbe37078b4bcf0367a7b91c21fe54a78e5687`. It bound the exact source revision, product/worker/engine/sandbox digests, successful sandbox cleanup, and `sourceCheckoutAvailable=true`. Engine, SCA, secrets, agent configuration, ML supply-chain, and AI App Security family receipts completed; URL was not applicable. AI App Security scanned all 217 eligible files (1,956,360 bytes) with zero skips or limits.
- CI `32966602739` and release `32967467190` deployed product `16a1fb7014ce3cbf9e56b69bff5074a5d0d8e0dd`: app `lyrashield-app--0000195`, scanner `lyrashield-scanner--0000176`, and egress proxy `lyrashield-egress-proxy--0000045` are healthy at 100% traffic. Worker digest `sha256:cb0f836eb54825517e900468a87c6d09b5e9df636121b49d8683b1766849fceb` runs that product with engine `852b1ed7ff76d177cef4db5aa1cfbd3bbe6d2664`; Docker health and `/api/ready/scans` passed after promotion and recovery testing.
- Production now includes billing-staging hardening, Redis/egress efficiency work, and the secure source-checkout recovery from PR #450. All Cloud and Local purchase admissions remain `off`; this deployment and Standard scan do not prove provider-hosted checkout or live billing.
- Isolated billing-staging is implemented as a protected, exact-main-SHA Azure workflow: it builds its own digest-pinned web/migration images in a staging ACR, runs image-owned migration/role executables inside the private VNet, keeps `app_runtime_staging` RLS-bound, and binds a separate no-membership/NOREPLICATION `app_system_staging` URL limited to license operations. External ingress is application-gated by an HttpOnly same-origin session, with only static access assets, signed billing webhooks, and exact health/readiness paths public. All production purchase admissions remain `off`; no staging workflow, hosted checkout, license flow, live charge, or provider activation is proven by the code change alone.
- Upstash authenticated TLS BullMQ Redis is live; public Azure `6379` rule is removed; legacy Redis is stopped/restart-disabled for rollback only.
- Production egress proof passed: direct arbitrary public fetch denied, authenticated proxy fetch allowed, loopback denied `ssrf_blocked`. During the accepted scan, an OSV pin change paused new admission and removed readiness while the paid job drained; it did not interrupt or replay the scan. The next timer restarted the exact worker digest, and readiness returned `200`. This bounded drain interval produced an expected temporary `503`; alerting must distinguish planned drain from an unexpected worker outage.
- Redis/egress efficiency code is deployed: slower idle BullMQ polling, single-key Lua heartbeat/readiness operations, DB-first reconciliation, proxy-only CISA enrichment, and drain-safe pin rotation. Live Redis command metrics and longer-window capacity evidence remain required.
- Encrypted backup and isolated restore verified schema, RLS, audit chain, and application startup.
- Production runtime DB role `app_runtime_prod` was queried on 2026-08-22 and verified `rolsuper=false`, `rolbypassrls=false`.
- Provider readiness remains bounded. A read-only Brave review on 2026-08-26 confirmed Razorpay Live activation, six matching INR Cloud plans, and one enabled eight-event production webhook. Polar Live has an active production token, fifteen private Cloud/pack/Local products, and an enabled lifecycle webhook. Razorpay hosted-checkout methods above INR 15,000, Polar settlement readiness, restricted Sandbox/Test hosted-checkout receipts, and all live entitlement/usage events remain unproven. No charge, provider mutation, new terms, or admission change occurred; every purchase admission remains `off`.
- CLI and GitHub Action classify added `eval()`/`exec()` as `HIGH`, so the default `--fail-on HIGH` gate blocks them.
- Dashboard is one adaptive authenticated surface: a state-derived next action, posture with exact evidence scope, compact metrics, recent activity, and progressive disclosure for technical depth. `GET /api/scans/eligibility` provides an advisory read-only preflight; `POST /api/scans` remains the authoritative gate. No mode switch changes permissions or scan behavior.
- Platform administration is implemented as a hidden, noindex, cross-workspace read console for overview, users, workspaces, scans, audit, and affiliates. Access requires an allowlisted, verified `PLATFORM_OPERATOR` browser session with recent TOTP; bearer credentials and workspace roles never grant access.
- Production configuration accepts exactly `ecryptoguru@gmail.com,ankit@lyrashieldai.com` as platform administrators. Preflight `32925726620` and apply `32925979621` passed; both accounts are unique, verified, TOTP-enrolled `PLATFORM_OPERATOR`s. Fresh independent Google-plus-TOTP sessions opened every bounded admin destination for both users. Unauthenticated, bearer-only, and workspace-header-only admin requests returned `401` with private/no-store caching.
- Production evidence-storage round-trip and missing-KEK fail-closed probes passed. Key Vault managed-identity license signing, denied-identity failure, Desktop fingerprint parity, and missing-secret failure passed; this is secret retrieval, not non-exportable remote signing.
- Both administrators acknowledged the Azure test notification. Exact zero-request provider evidence cleared the historical terminal-cost alert under receipt `f952706e6ced8105f8d12f530186939f33b0074b6ff17f4eb17a04afd81eeb84` without changing money columns.
- The controlled orphan drill moved synthetic scan `cmta574d50004fef1nbydufai` to `FAILED/QUEUE_ORPHANED` without engine execution or replay, retained verification/cleanup audits, restored the exact worker digest, reconciled both queues to zero, and resumed admission.
- A temporary internal scorecard passed page, referral, privacy, deduplication, DNT/GPC, three-card, badge, LinkedIn unfurl, and revocation checks. The pass found canonical/OG metadata baked to the scanner origin; this change fixes it with a regression test. Exact-SHA deployment and live canonical readback remain required.
- Platform-affiliate mutations remain disabled until each write is connected to the one-time action elevation and atomic platform-audit transaction. The current admin console is read-only.
- Agent distribution now uses CLI `0.2.0`, MCP `0.2.4` on MCP SDK `1.30`, Agent Plugin `0.1.18`, Node 24 support, hosted OAuth/read-only-by-default remote MCP, and 30 registry entries representing 26 preferred client surfaces. Do not update Node 26 types, ESLint 10, ioredis 6, or TypeScript 7 until compatibility migrations are planned.
- Marketing ships indexability-gated `robots.txt`, sitemap, dated `llms.txt`, `agents.md`, structured data, canonical integration guides, comparison/research pages, and explicit answer-engine crawler policy. These are SEO/AEO/GEO foundations, not proof of webmaster indexing or answer-engine citation.

Claims boundary: this is bounded runtime/accounting evidence for one target and revision, not proof of universal coverage, independently verified findings, or security.

## Immediate execution queue

1. Merge and deploy the scorecard canonical-origin fix, then repeat live canonical and OG readback on the exact SHA.
2. Run restricted Polar Sandbox and Razorpay Test Mode billing staging end to end. Keep every production admission `off`; Razorpay hosted-checkout methods above INR 15,000 remain transaction-unproven.
3. Retain longer-window Redis command/capacity evidence and complete RazorpayX/Payoneer payout plus tax-form operations before paid scale.
4. Triage the 25 findings retained by current Standard scan `cmt9el7p7000001hdjnjo90wk` and obtain independent verification where warranted. Keep all unverified results `DETECTED` or `INCONCLUSIVE`.
5. After founder authorization, run separate controlled Deep/Terra acceptance with exact image, routing, cost, receipts, and terminal proof.

## Founder decisions

- Trademark clearance.
- Public paid-launch timing and publishable pricing.
- Enable production Polar/Razorpay purchase admissions.
- Provider/model and target for first Deep/Terra acceptance.

## Non-negotiable implementation rules

- Never push directly to `main`; use a focused branch and PR.
- Preserve user changes and avoid unrelated refactors or formatting churn.
- Inspect current code/schema/callers before editing; documentation never beats executable truth.
- Scope every workspace query by `workspaceId`; validate trust-boundary inputs with Zod.
- Use `@lyrashield/logger`; audit sensitive mutations through the extended Prisma client.
- Use shared UI, API helpers, queue helpers, security helpers, and domain services.
- Add focused regression coverage for changed behavior, especially security, money, tenancy, evidence, and lifecycle paths.
- Verify relevant work with lint, typecheck, tests, build, formatting, migrations, security scans, browser proof, and `git diff --check`.
- Money is `Decimal @db.Decimal(19,4)`, never Float. IDs are cuid. Webhooks, usage, packs, refunds, commissions, and payouts are idempotent.
- Decimal policy: billing/ledger amounts are `Decimal(19,4)`. Telemetry and analytics may use purpose-specific decimal scales; never migrate telemetry values into money columns or vice versa without an explicit reviewed schema change.
- Public copy must not claim certification, compliance, guaranteed security, universal detection, adversarial robustness, or unnamed “AI safety testing.”
- Never expose model costs in dashboard/public payloads or name the upstream engine publicly.
- Desktop contains no LyraShield model keys. Production license signing uses managed identity and fails closed.

## Landmines

### Tenancy and database

- `SOFT_DELETE_MODELS` may contain only models with `deletedAt`; `WORKSPACE_SCOPED_MODELS` only models with `workspaceId`.
- Workspace context uses `AsyncLocalStorage`; never replace it with module state.
- Use `withWorkspaceRLS(workspaceId, fn)` so `SET LOCAL` remains connection-safe.
- Runtime `DATABASE_URL` must not use superuser or `BYPASSRLS` role.
- New production migrations are additive/backward-compatible and forward-only; image rollback never reverses schema.
- Preserve `Schedule.targetId` FK and child-table RLS migrations.

### Audit, evidence, and results

- Create audit rows through `prisma.auditLog.create()`. Do not nest them in another Prisma transaction; advisory lock owns chain order.
- Every `Evidence` uses `uploadEvidence()` with checksum and valid encryption key reference. No `encrypted://` placeholders.
- Engine output is untrusted and bounded. Confidence never means verification.
- Persist claims through manifest, coverage receipt, candidate, and verification receipt.
- Only complete deterministic retest may produce `VALIDATED`; engine-only absence is `INCONCLUSIVE`.
- Retest validation binds to stored immutable evidence: the finding's original source scan and the retest scan must both have stored manifests, exact repository revisions (which may differ after a fix) or matching URL checksums, and complete deterministic coverage. Missing identity stays `INCONCLUSIVE` and never sets `FIXED`.
- The result manifest is persisted before retest finalization; crash recovery resumes pending retests before scoring without replaying billable work.
- Finding detail exposes no raw evidence storage URIs; retest receipts surface scan IDs, manifest checksums, revisions, method, and coverage state.
- `Policy.maxBudgetUsd` is nullable but never negative; PostgreSQL enforces `Policy_maxBudgetUsd_nonnegative`.
- Findings list pages carry a deterministic, page-local Priority heuristic (severity, status, verified, confidence, target environment, business-impact/exploitability context). It is triage context, never a claim of exploitability or reachability, and does not change cursor pagination.
- Result manifests bind worker execution provenance (`LYRASHIELD_PRODUCT_REVISION`, `LYRASHIELD_WORKER_IMAGE_DIGEST`, `LYRASHIELD_ENGINE_REVISION`) into the checksum; the production worker fails closed before readiness without them, and `run-worker.sh` derives them only from the digest-pinned image and its OCI labels.
- `provision-alerts.sh` readback-fails unless every rule is enabled, auto-mitigates, and binds the operator action group; `scan_worker_lease_expired` is never provisioned until a durable counter exists.
- `verify:launch-assurance` is dry-run-first and read-only by default; mutation requires exact scan/workspace IDs, the production confirmation phrase, authenticated cancellation, and shared queue recovery only.
- Direct updates must not set `FIXED`; retain `FIXED_PENDING_RETEST` until trusted retest receipt.

### Queue, worker, and network

- Queue authority is `packages/integrations/src/queue.ts`; use `enqueueScan()` and `getScanQueue()`.
- Treat BullMQ job identity and data as untrusted: require `job.id === scanId`, then bind
  workspace, target, goal, mode, and policy back to the stored scan before execution.
- Never create one-off queues, delete BullMQ keys directly, or auto-requeue ambiguous paid work.
- Worker heartbeat and readiness use single-key Lua operations. Keep the admission-stop `EXISTS` check separate because its key is in a different Redis Cluster slot.
- Reconcile unconditionally at worker start; on five-minute ticks, inspect BullMQ when the DB has nonterminal scans, at least hourly while idle, and whenever the DB preflight is uncertain. Never turn that uncertainty into a skipped reconciliation.
- Invoke external engine only for `REPO`; URL/API use deterministic scanners.
- `REDIS_URL` is BullMQ TCP; `UPSTASH_REDIS_REST_URL/TOKEN` are rate limiting. Never interchange them.
- Keep worker and engine child on the same protected, host-visible `TMPDIR`; pre-create
  local bind roots with restrictive permissions and never recursively chown a predictable
  shared `/tmp` path.
- Meter agent-minutes only after a scan-bound completed receipt or scan-bound affirmative
  provider usage. Deterministic URL/API scans and pre-provider failures are non-billable.
- Set `TRUSTED_PROXY_IP_HEADER` only when ingress strips incoming copies and writes the authoritative value.
- Keep authenticated egress proxy, DNS pinning, drain-before-restart, union rollback/fail-close, and negative egress tests intact. CISA KEV uses the proxy; a direct CISA pin is allowed only as the staged legacy route while rolling out the proxy-capable worker first.

### Models and agents

- Routing authority: `resolveEngineProfile()`; budget authority: `resolveScanBudgetUsd()`; price authority: `gpt56-pricing.ts`.
- Keep validated fallback model and positive policy checks.
- Deep/Custom are Terra-root/Luna-specialist profiles, not a Luna-to-Terra cascade.
- Model-facing inputs use `normalizeInput()` and `PromptInjectionGuard`; no ad hoc regex replacement.
- Remote write scope never bypasses exact-input approval.

### GitHub, public sharing, billing, and licenses

- Callback state alone cannot create a GitHub integration.
- Fix PR route accepts no client patch, branch, title, or body; server-generated approval-bound patch remains required.
- `buildScorecardPayload()` is the only public payload constructor. Keep analytics allowlist private and minimal.
- Billing webhook records idempotent `WebhookEvent` before Track A/B/C processing.
- Keep Brevo binding while email verification is enabled.
- Revoked licenses never use perpetual fallback.
- Affiliate annual rate is flat 25%; 30% tier applies monthly only. No commission on packs, trials, or self-referrals.
- Marketing deploy uses generated `apps/marketing/dist/server/wrangler.json`, not source `wrangler.jsonc`.

## Repository hygiene

- Build outputs and generated media are gitignored; never commit `.next`, `dist`, `.turbo`, motion renders, media-local, generated Prisma client, or `node_modules`.
- Heavy media belongs in remote storage or deterministic regeneration workflow.
- `@lyrashield/cli` is deprecated; unscoped `lyrashield` is canonical.
- Engine imports are reviewed stable-release changes; never mechanically rebrand upstream, force-push, bypass CI, or auto-resolve conflicts.

## Documentation ownership

- [PRD.md](./PRD.md): strategy, scope, release status, backlog, founder decisions.
- [Phase2.md](./Phase2.md): dated future-roadmap planning overlay followed by the verbatim original archive; do not treat historical status as current.
- [codebase.md](./codebase.md): architecture, code map, runtime contracts, compact history.
- [AGENTS.md](./AGENTS.md): current handoff, queue, rules, landmines.
- [product.md](./product.md): positioning and commercial decisions.
- [userguide.md](./userguide.md): user workflows and limitations.
- [monetization.md](./monetization.md): pricing and affiliate economics.
- `docs/deployment/*` and `docs/ops/*`: deployment and operational procedures.
- [docs/README.md](./docs/README.md): document ownership and retention map.

After merge, remove branch-only wording and update all affected truth documents. Keep historical detail in Git/PRs, not copied into current summaries.
