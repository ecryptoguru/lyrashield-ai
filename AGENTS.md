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

## Current verified state — 2026-08-23

- Open beta with open registration at `https://app.lyrashieldai.com/sign-up`; never call it pre-launch or a waitlist.
- Marketing, passive Lite Scanner, authenticated app origin, Cloudflare bindings, TLS, sitemap/robots/`llms.txt`, security headers, and open-registration CTAs are live.
- Core Sprints 0–10 are merged: auth/tenancy, scan pipeline, findings/evidence/retests/reports, notifications/schedules, scorecards/referrals, agent/MCP/CLI/plugin, Polar/Razorpay billing, Local/Desktop, and affiliates.
- Engine version 1.2.1 over pinned Strix v1.5.3. Safe/Quick/Standard use Luna/medium; Deep/Custom use Terra/medium root plus Luna/high specialists. Caps: $1.20/$1.20/$3.20/$5/$5.
- Current Standard acceptance: scan `cmt35aj1s000001hck9fmguzk`, `OnboardingAI2@1689f3607d68764e09769535df8e368c4d5ad2fe`, completed in 11m 42s. All 184 requests used Luna/medium; cost reconciled to $0.597148; 12 minutes debited; 24 findings retained; zero independently verified; AI App Security hit its 200-file bound.
- AI App Security coverage remediation is live for future scans: deterministic production/config source prioritization; mode caps of 200/500/1,000 files for Quick/Standard/Deep; generated-artifact exclusions; structured scanned/skipped counts and path samples; and immutable AI-family coverage receipts. A bounded AI layer remains `INCONCLUSIVE`; the historical scan above remains bounded.
- Worker digest `sha256:d7dd33c2823a6152cc5b99d27ce6ef9e1acccf7cb203fff9def4550789054b01` runs product `8ee6fd50e55bfb6d3ca20c6b9209e8a9423c2056` and engine `dd588c379ae6614e0914b8adb41d94f0c1e86c26`. App revision `lyrashield-app--0000155` and the worker are healthy.
- Upstash authenticated TLS BullMQ Redis is live; public Azure `6379` rule is removed; legacy Redis is stopped/restart-disabled for rollback only.
- Production egress proof passed: direct arbitrary public fetch denied, authenticated proxy fetch allowed, loopback denied `ssrf_blocked`. DNS refresh stayed active during the paid scan without restarting worker.
- Encrypted backup and isolated restore verified schema, RLS, audit chain, and application startup.
- Production runtime DB role `app_runtime_prod` was queried on 2026-08-22 and verified `rolsuper=false`, `rolbypassrls=false`.
- Polar/Razorpay test credentials, product/price maps, webhook secrets, signed smoke, and non-charge objects are configured. Live paid activation remains founder-controlled.
- Provider-specific checkout admission is implemented with production defaults
  off, exact canary workspaces, and webhook settlement left enabled. No public
  Local-license checkout route exists yet.
- Desktop `0.1.1` is prepared in code with seven-day offline grace and a
  user-confirmed signed updater, but it is not signed or published.
- GitHub environment `desktop-release` has required-reviewer and `main`/`v*`
  deployment policies. Its updater secrets match the committed public key and
  are backed up in Key Vault; repository-wide copies were removed. A
  release-only Entra application has exact-environment GitHub OIDC federation
  and no client secret. Azure `Microsoft.CodeSigning` is registered, but no
  Artifact Signing account, completed public identity validation, certificate
  profile, profile-scoped signer role, or Apple signing credentials exist yet.
- CLI and GitHub Action classify added `eval()`/`exec()` as `HIGH`, so the default `--fail-on HIGH` gate blocks them.

Claims boundary: this is bounded runtime/accounting evidence for one target and revision, not proof of universal coverage, independently verified findings, or security.

## Immediate execution queue

1. Prove private S3-compatible evidence upload, encryption, retrieval, isolation, and fail-closed behavior in production.
2. Connect readiness, queue, provider, model-cost, and worker logs to actionable alerts; record capacity evidence and incident ownership.
3. Run worker cancellation and queue recovery under production failure injection without replaying ambiguous paid work.
4. Run founder-approved Polar and Razorpay canaries independently, then open each provider only after its 24-hour evidence gate.
5. Complete and prove production Azure Key Vault license signing.
6. Provision RazorpayX/Payoneer payout APIs and tax-form workflow.
7. Verify public scorecard metadata, all card formats, badge, revocation/expiry, referrals, human-event deduplication, external unfurls, and webmaster submission.
8. Triage current Standard findings and obtain independent verification where warranted.
9. After founder authorization, run separate controlled Deep/Terra acceptance with exact image, routing, cost, receipts, and terminal proof.

## Founder decisions

- Trademark clearance.
- Public paid-launch timing and publishable pricing.
- Live Polar/Razorpay activation.
- Signed Desktop publication and stale `v0.1.0` draft deletion.
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
