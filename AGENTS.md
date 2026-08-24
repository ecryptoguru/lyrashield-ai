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

## Current verified state — 2026-08-25

- Open beta with open registration at `https://app.lyrashieldai.com/sign-up`; never call it pre-launch or a waitlist.
- Marketing, passive Lite Scanner, authenticated app origin, Cloudflare bindings, TLS, sitemap/robots/`llms.txt`, security headers, and open-registration CTAs are live.
- Core Sprints 0–10 are merged: auth/tenancy, scan pipeline, findings/evidence/retests/reports, notifications/schedules, scorecards/referrals, agent/MCP/CLI/plugin, Polar/Razorpay billing, Local/Desktop, and affiliates.
- Engine version 1.2.1 over pinned Strix v1.5.3. Safe/Quick/Standard use Luna/medium; Deep/Custom use Terra/medium root plus Luna/high specialists. Caps: $1.20/$1.20/$3.20/$5/$5.
- Current Standard acceptance: scan `cmt35aj1s000001hck9fmguzk`, `OnboardingAI2@1689f3607d68764e09769535df8e368c4d5ad2fe`, completed in 11m 42s. All 184 requests used Luna/medium; cost reconciled to $0.597148; 12 minutes debited; 24 findings retained; zero independently verified; AI App Security hit its 200-file bound.
- AI App Security coverage remediation is live for future scans: deterministic production/config source prioritization; mode caps of 200/500/1,000 files for Quick/Standard/Deep; generated-artifact exclusions; structured scanned/skipped counts and path samples; and immutable AI-family coverage receipts. A bounded AI layer remains `INCONCLUSIVE`; the historical scan above remains bounded.
- Release run `32738811470` deployed product `8347fda923032960661079491a0a17956aebefd9`: app `lyrashield-app--0000170`, scanner `lyrashield-scanner--0000151`, and egress proxy `lyrashield-egress-proxy--0000020` are healthy at 100% traffic. The separately promoted worker digest `sha256:6f73ad5e1125fffd8b4eec85103d14b49eb0c6a1765cab29a1a5edb3d7a17413` runs that product revision with engine `944a84f15f913909039c89146c25db650cd87137`; Docker health and `/api/ready/scans` passed after promotion, and the prior worker configuration remains as the rollback record.
- Product `main` is `3966e24c` after PRs #421–#424 and the current assurance hardening PRs #428–#430 (nonnegative policy budgets, explainable finding priority, immutable retest receipts, raw evidence-storage URI removal, worker execution provenance, actionable Azure alert provisioning, and a bounded host-side launch-assurance orchestrator). CI is green, but that code is not deployed. Release run `32755678337` built and pushed images, then failed closed before Azure login, migrations, revision creation, or runtime mutation because the protected Razorpay credential is Test Mode while production requires Live Mode. Production remains healthy on `8347fda9`; all Cloud and Local purchase admissions remain `off`.
- Upstash authenticated TLS BullMQ Redis is live; public Azure `6379` rule is removed; legacy Redis is stopped/restart-disabled for rollback only.
- Production egress proof passed: direct arbitrary public fetch denied, authenticated proxy fetch allowed, loopback denied `ssrf_blocked`. DNS refresh stayed active during the paid scan without restarting worker.
- Encrypted backup and isolated restore verified schema, RLS, audit chain, and application startup.
- Production runtime DB role `app_runtime_prod` was queried on 2026-08-22 and verified `rolsuper=false`, `rolbypassrls=false`.
- Provider readiness remains bounded. A read-only Brave review on 2026-08-24 found six Razorpay Test Mode cloud plans; the live account is activated and its website is approved, but its live plan catalog and webhook configuration are empty. Polar Sandbox has no active products or organization token; Polar Live setup is 5/7 with identity verification and payouts pending and no active products. No charge, credential creation, new terms, admission change, or provider mutation was performed. Live paid activation remains founder-controlled.
- CLI and GitHub Action classify added `eval()`/`exec()` as `HIGH`, so the default `--fail-on HIGH` gate blocks them.
- Dashboard now has workspace-scoped Guided and Pro experiences. Guided is the safe default and keeps launch-critical actions; Pro adds risk posture, retained-finding, remediation, and recent-scan detail without changing permissions or scan behavior.
- Platform administration is implemented as a hidden, noindex, cross-workspace read console for overview, users, workspaces, scans, audit, and affiliates. Access requires an allowlisted, verified `PLATFORM_OPERATOR` browser session with recent TOTP; bearer credentials and workspace roles never grant access.
- Production configuration accepts exactly `ecryptoguru@gmail.com,ankit@lyrashieldai.com` as platform administrators. Provisioning is fail-closed: read-only preflight first, then explicit apply; both accounts must already be unique, email-verified, and TOTP-enrolled. Apply revokes their sessions/elevations and writes a bootstrap audit receipt.
- Platform-affiliate mutations remain disabled until each write is connected to the one-time action elevation and atomic platform-audit transaction. The current admin console is read-only.
- Agent distribution now uses CLI `0.2.0`, MCP `0.2.2` on MCP SDK `1.30`, Agent Plugin `0.1.18`, Node 24 support, hosted OAuth/read-only-by-default remote MCP, and 30 registry entries representing 26 preferred client surfaces. Do not update Node 26 types, ESLint 10, ioredis 6, or TypeScript 7 until compatibility migrations are planned.
- Marketing ships indexability-gated `robots.txt`, sitemap, dated `llms.txt`, `agents.md`, structured data, canonical integration guides, comparison/research pages, and explicit answer-engine crawler policy. These are SEO/AEO/GEO foundations, not proof of webmaster indexing or answer-engine citation.

Claims boundary: this is bounded runtime/accounting evidence for one target and revision, not proof of universal coverage, independently verified findings, or security.

## Immediate execution queue

1. Prove private S3-compatible evidence upload, encryption, retrieval, isolation, and fail-closed behavior in production. The `verify:launch-assurance` orchestrator (PR #429) composes the fail-closed and round-trip evidence-storage proofs in code; production execution with exact scan/workspace IDs and the confirmation phrase remains the gate.
2. Connect readiness, queue, provider, model-cost, and worker logs to actionable alerts; record capacity evidence and incident ownership. `provision-alerts.sh` and the monitoring launch runbook (PR #429) define the rule inventory, action-group binding, readback, and idempotent provisioning; production provisioning and a test-alert acknowledgment remain the gate.
3. Run worker cancellation and queue recovery under production failure injection without replaying ambiguous paid work. The `verify:launch-assurance` orchestrator (PR #429) composes authenticated cancellation, settle wait, `reconcileScanQueue`, and post-recovery readiness in code; production failure injection with exact scan/workspace IDs and the confirmation phrase remains the gate.
4. Complete provider live-mode setup: provision matching live credentials, product/plan catalogs, and webhooks; rerun the fail-closed deployment; then verify live-provider entitlement and usage events without enabling purchase admission until founder approval. Razorpay hosted-checkout payment methods above INR 15,000 remain transaction-unproven.
5. Complete and prove production Azure Key Vault license signing.
6. Provision RazorpayX/Payoneer payout APIs and tax-form workflow.
7. Verify public scorecard metadata, all card formats, badge, revocation/expiry, referrals, human-event deduplication, external unfurls, and webmaster submission.
8. Triage current Standard findings and obtain independent verification where warranted.
9. After founder authorization, run separate controlled Deep/Terra acceptance with exact image, routing, cost, receipts, and terminal proof.
10. Complete personal TOTP enrollment for `ecryptoguru@gmail.com`, then rerun exact-two production platform-admin preflight. Read-only main run `32733611844` proved the isolated client reached account validation and failed because that verified account has no TOTP; `ankit@lyrashieldai.com` was not evaluated after the first fail-closed result. No apply or account/session/role mutation occurred. Only apply roles after both accounts pass, then capture fresh-session MFA browser proof.

## Founder decisions

- Trademark clearance.
- Public paid-launch timing and publishable pricing.
- Live Polar/Razorpay activation.
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
- Never create one-off queues, delete BullMQ keys directly, or auto-requeue ambiguous paid work.
- Invoke external engine only for `REPO`; URL/API use deterministic scanners.
- `REDIS_URL` is BullMQ TCP; `UPSTASH_REDIS_REST_URL/TOKEN` are rate limiting. Never interchange them.
- Set `TRUSTED_PROXY_IP_HEADER` only when ingress strips incoming copies and writes the authoritative value.
- Keep authenticated egress proxy, DNS pinning, active-scan restart deferral, and negative egress tests intact.

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
- [Phase2.md](./Phase2.md): verbatim original Phase 2/future-roadmap archive; do not treat historical status as current.
- [codebase.md](./codebase.md): architecture, code map, runtime contracts, compact history.
- [AGENTS.md](./AGENTS.md): current handoff, queue, rules, landmines.
- [product.md](./product.md): positioning and commercial decisions.
- [userguide.md](./userguide.md): user workflows and limitations.
- [monetization.md](./monetization.md): pricing and affiliate economics.
- `docs/deployment/*` and `docs/ops/*`: deployment and operational procedures.
- [docs/README.md](./docs/README.md): document ownership and retention map.

After merge, remove branch-only wording and update all affected truth documents. Keep historical detail in Git/PRs, not copied into current summaries.
