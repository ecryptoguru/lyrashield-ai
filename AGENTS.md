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

## Release contract — 2026-09-25

- Cloud and Desktop release workflows pin engine `be980600155b3a16aebc6cf381d3c7e37e295617`, which includes the GPT-6-only model boundary and Local scan integrity/viewer fixes. A source pin does not establish a completed deployment or signed Desktop release; verify the exact release run separately. Desktop launch work remains deferred.
- Product `main` requires `SCA & Secret Scan`, `Lint, Typecheck, Test & Build` and `Pinned Engine / Worker Contract`, with strict up-to-date branch checks. Update the engine's reverse `.lyrashield-worker-pin` only to an exact merged product commit after compatibility verification.

Current release and runtime evidence lives in [PRD §8](./PRD.md#8-current-production-evidence) and [codebase §11](./codebase.md#11-production-topology-and-accepted-evidence). Refresh deployed state before operational action.

## Immediate execution queue

1. Merge and deploy the scorecard canonical-origin fix, then repeat live canonical and OG readback on the exact SHA.
2. Retain longer-window Redis command/capacity evidence and complete RazorpayX/Payoneer payout plus tax-form operations before paid scale.
3. Triage the 25 findings retained by current Standard scan `cmt9el7p7000001hdjnjo90wk` and obtain independent verification where warranted. Keep all unverified results `DETECTED` or `INCONCLUSIVE`.
4. After founder authorization, run separate controlled Deep/Sol acceptance with exact image, routing, cost, receipts, and terminal proof.

## Founder decisions

- Trademark clearance.
- Confirm intended current public Cloud-admission posture and authorize each live checkout/refund proof; Local admissions remain off.

Decided on 2026-09-22: retain and publish the existing Cloud and minute-pack prices; keep repository MCP/WebMCP findings visible on Trial and Starter; use OnboardingAI2 at its fixed revision with the current production Deep profile for controlled acceptance; and permit capability-bound public release-identity confirmation that returns only `MATCH`, `MISMATCH` or `UNAVAILABLE` without disclosing the stored identity. None of these decisions authorizes a new live charge, cancellation or refund.

## Non-negotiable implementation rules

- Never push directly to `main`; use a focused branch and PR.
- Preserve user changes and avoid unrelated refactors or formatting churn.
- Inspect current code/schema/callers before editing; documentation never beats executable truth.
- Scope every workspace query by `workspaceId`; validate trust-boundary inputs with Zod.
- Billing ownership is account-level: subscriptions, allowances, usage, packs, grace, and overage belong to `BillingAccount.accountId`/`UsageRecord.accountId`/`MinutePack.accountId`; `workspaceId` on those rows is attribution only. Sponsor identity comes from trusted persisted state (`Scan.createdById`, `session.userId`), never client-supplied payer IDs, and fails closed. Entitlement decisions use the sponsor account's `effectivePlan`; `workspace.plan` is a display mirror only. Bind account context with `withAccountRLS`/`withWorkspaceRLS(..., { accountId })` for account-owned ledger access.
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
- Standards registry `1.1.0` uses version-pinned categories and a selected ASVS L1 subset. Scanner-family completion is bounded category evidence, never proof of full-standard coverage or compliance. Missing, unreadable, or capped scanner inputs must remain incomplete.
- Persist claims through manifest, coverage receipt, candidate, and verification receipt.
- Only complete deterministic retest may produce `VALIDATED`; engine-only absence is `INCONCLUSIVE`.
- Retest validation binds to stored immutable evidence: the finding's original source scan and the retest scan must both have stored manifests, exact repository revisions (which may differ after a fix) or matching URL checksums, and complete deterministic coverage. Missing identity stays `INCONCLUSIVE` and never sets `FIXED`.
- The result manifest is persisted before retest finalization; crash recovery resumes pending retests before scoring without replaying billable work.
- Finding detail exposes no raw evidence storage URIs; retest receipts surface scan IDs, manifest checksums, revisions, method, and coverage state.
- `Policy.maxBudgetUsd` is nullable but never negative; PostgreSQL enforces `Policy_maxBudgetUsd_nonnegative`.
- Findings list pages carry a deterministic, page-local Priority heuristic (severity, status, verified, confidence, target environment, business-impact/exploitability context). It is triage context, never a claim of exploitability or reachability, and does not change cursor pagination.
- Result manifests bind worker execution provenance (`LYRASHIELD_PRODUCT_REVISION`, `LYRASHIELD_WORKER_IMAGE_DIGEST`, `LYRASHIELD_ENGINE_REVISION`) into the checksum; the production worker fails closed before readiness without them, and `run-worker.sh` derives them only from the digest-pinned image and its OCI labels. New rows store the exact JSON checksum input and hash those bytes. `verifyStoredManifestChecksum` verifies SHA-256 and structural equality with JSONB; duplicate persistence and pending finalization reject mismatches. Null legacy input remains `UNAVAILABLE`, with no backfill or historical-hash rewrite.
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
- Invoke the engine for `REPO` and the engine-backed URL/API Standard/Deep profiles; URL/API Safe/Quick remain deterministic-only. Engine target traffic requires current domain verification and a scan-scoped relay grant. The remote relay rejects opaque CONNECT tunnels; the sandbox-local TLS adapter uses the installed sandbox CA for HTTPS clients. Composed local curl and Chromium navigation/fetch tests passed allowed requests and denied path/method/redirect requests without disabling TLS validation. Exact-image production deployment and a paid URL engine scan remain unverified.
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
- Deep/Custom use GPT-6 Sol/medium root and Luna/high specialists; see [model routing](./codebase.md#model-routing-and-accounting).
- Model-facing inputs use `normalizeInput()` and `PromptInjectionGuard`; no ad hoc regex replacement.
- Workspace API keys are managed by Owners and Admins with browser sessions. The raw key is shown once and only its hash is stored; verification remains bound to the workspace, active creator membership, scope, and current permission. Use read-only scope where possible and never place a key in shared client configuration.
- Remote OAuth is read-only by default. A valid browser-confirmed delegation may authorize only its recorded workflows, targets, and scan profiles; revalidate membership, permission, connection state, scope, expiry, and idempotency at execution. Hosted remote MCP mutations without that grant, including API-key and legacy `approvalId` calls, receive `connect_required`; direct REST and local stdio use the separate credential-scope and workspace-permission path.

### GitHub, public sharing, billing, and licenses

- Callback state alone cannot create a GitHub integration.
- Fix PR route accepts no client patch, branch, title, or body; server-generated approval-bound patch remains required.
- `buildScorecardPayload()` is the only public payload constructor. Keep analytics allowlist private and minimal.
- Billing webhook records idempotent `WebhookEvent` before Track A/B/C processing.
- Keep Brevo binding while email verification is enabled.
- Revoked licenses never use perpetual fallback.
- Affiliate annual rate is flat 25%; 30% tier applies monthly only. No commission on packs, trials, or self-referrals.
- Marketing deploy uses generated `apps/marketing/dist/server/wrangler.json`, not source `wrangler.jsonc`.

## Verification and release commands

Local gates — run the ones a change touches before opening a PR:

- `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm typecheck:e2e`, `pnpm format:check`.
- `pnpm lint:md` — advisory markdownlint pass (`.markdownlint-cli2.jsonc`); wired non-blocking in CI.
- `pnpm test:core` (vitest unit suite), `pnpm test:marketing`, `pnpm test:motion`, `pnpm test` (full runner), `pnpm test:e2e` (Playwright; needs the test database).
- `pnpm db:generate`, `pnpm db:migrate`, `pnpm prisma:migrate:check` (migration drift).
- `pnpm verify:worker-image` — worker image contract on the checked-out Dockerfile and host assets.
- Deploy-script suites: `node --test .github/scripts/tests/*.test.mjs` and `for t in .github/scripts/tests/*.sh; do bash "$t" || exit 1; done`. These mock `docker`/`systemctl`/`curl` and never touch a real VM.

Release pipeline — GitHub Actions only; production steps are founder-dispatched:

- `ci.yml` gates every PR: SCA/secret scan, path classification, lint/typecheck/test/build, pinned engine-worker contract, desktop jobs, marketing deploy on main push.
- `release-production.yml` dispatches `deploy-azure.yml`: builds the digest-pinned worker image, promotes `lyrashield-worker.service` through `.github/scripts/promote-worker-vm.sh` (admission stop → secrets refresh → empty-queue preflight → restart → readiness), then rolls app/scanner and the Cloudflare marketing worker.
- `promote-worker-vm.sh --preflight` runs only the queue check against the refreshed environment file; it never restarts the live worker.
- `production-scan-readiness.yml` probes `https://app.lyrashieldai.com/api/ready/scans` and writes the probe status/body to the step summary on failure.
- Local `.env` values are developer-specific (Myra flags, provider credentials); a red `env-runtime` test or web build caused by them is environmental, not a regression — compare against a clean checkout before claiming breakage.

## Repository hygiene

- Build outputs and generated media are gitignored; never commit `.next`, `dist`, `.turbo`, motion renders, media-local, generated Prisma client, or `node_modules`.
- Heavy media belongs in remote storage or deterministic regeneration workflow.
- `@lyrashield/cli` is deprecated; unscoped `lyrashield` is canonical.
- Engine imports are reviewed stable-release changes; never mechanically rebrand upstream, force-push, bypass CI, or auto-resolve conflicts.

## Documentation ownership

See [docs/README.md](./docs/README.md) for the current document map, including [operator runbooks](./docs/operations.md) and retention rules.

After merge, remove branch-only wording and update all affected truth documents. Keep historical detail in Git/PRs, not copied into current summaries.
