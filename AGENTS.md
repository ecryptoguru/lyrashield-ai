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

## Release contract — 2026-11-15 (production recovery)

- Candidate Cloud, recovery and Desktop release workflows pin merged engine `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c` (engine PRs #240 and #242). This retains the established model, bounded-runtime, acquisition, relay and evidence contracts and adds signed attach-only controller sandbox execution; the root producer and engine consume the same canonical SDK manifest bytes. Evaluation profiles remain unmeasured and public benchmark claims disabled. The runtime-fleet gate is retired: `release-production.yml` no longer requires `LYRASHIELD_RUNTIME_FLEET_EVIDENCE`/`qualify-runtime`; deployment flows main push → route → `deploy-azure.yml` (source qualification, exact-image build, disposable rehearsal, guarded rollout), with marketing independent. Retained-worker and high-availability lanes remain held. Repository scans keep the pinned sandbox image, the egress-restricted sandbox network and the deny-by-default firewall. A source pin does not establish deployment or a signed Desktop release; Desktop launch remains deferred.
- Product `main` requires `SCA & Secret Scan`, `Lint, Typecheck, Test & Build` and `Pinned Engine / Worker Contract`, with strict up-to-date branch checks. Update the engine's reverse `.lyrashield-worker-pin` only to an exact merged product commit after compatibility verification.

GitHub protection readback on 2026-10-28 confirms the three required checks bound to GitHub Actions, strict base freshness, required PRs, administrator enforcement, and disabled force pushes/deletion. No extra reviewer approval is required. This supersedes the earlier provider-plan restriction. Explicitly wait for the exact PR commit's required checks before merging; never use a bypass. The release workflow also qualifies the tested PR base/head and merged source tree before deployment.

Current release and runtime evidence lives in [PRD §8](./PRD.md#8-current-production-evidence) and [codebase §11](./codebase.md#11-production-topology-and-accepted-evidence). Refresh deployed state before operational action.

## Operational handoff

Current production is `679021c069789ad2060f60d38b1d8261fd56b9d6` from PR #1147, released successfully by [43796371038](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43796371038). App/scanner/proxy `0000523`/`0000497`/`0000363` are healthy at 100%; worker digest `sha256:2bbe9ace4dead4f92f07198c039a6adc40a70baacd53aeff36dd65196b49432b` runs engine `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c`. Fresh controlled Standard/Deep ran on preceding deployed `637a178ae`; the native OAuth provenance repair and 20 tenant/credential/MCP assertions passed on `679021c0`, plus 11 report-sharing assertions. URL SAFE proof is deterministic and uncharged; repository SAFE aliases model-backed QUICK. The accidentally selected repository probe was cancelled with 2 minutes recorded; total allowance use is 123/4,500. Coordinated candidates MCP 0.2.13 / Agent Plugin 0.1.32 / CLI 0.2.15 supply the missing setup-health tool and repair the CLI ESM scan loader, with exact pins prepared on draft PR #1148. npm login/publication and registry readback are required before merging those pins; public versions remain 0.2.12 / 0.1.31 / 0.2.14. See [PRD §8](./PRD.md#hosted-acceptance-and-client-provenance--2026-11-16-0355-utc) for exact receipts and limits. Broker authority (#7) stays deferred; financial and physical-device/screen-reader qualification are excluded.

Prior production evidence is the November 16 22:16 release record: [release 43764099383](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43764099383) deployed product `637a178ae589a4545224afb1e13c4b694fefd679` ([PR #1143](https://github.com/ecryptoguru/lyrashield-ai/pull/1143)) after the three required checks passed on its exact head and the exact-image rehearsal succeeded. An independent readback at `2026-11-15T22:16:36Z` found app `lyrashield-app--0000521`, scanner `lyrashield-scanner--0000495` and egress proxy `lyrashield-egress-proxy--0000361` healthy at 100% traffic on web digest `sha256:a6519ad2405396ead775d8290640a7b3ed149c60d185c9c9cd7513ebe24d5126` and proxy digest `sha256:695a12e102dfedea1aff0a812f72c80b35f761af87f6eb086e93afc083211fb5`; the worker container (active since `2026-11-15T22:14:46Z`, zero restarts) runs image `sha256:138d435fd5b17d819bd8136ec43d8d0856434f0d93067bd9275c15749d44ea70` with product revision `637a178ae589a4545224afb1e13c4b694fefd679` and engine `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c`. App, scanner and scan readiness returned 200; marketing serves build revision `637a178ae`; the scan admission stop is unset and the BullMQ queues are empty. That release makes a retest baseline refusal a terminal, uncharged, non-retried outcome, restores the paginated fix-proposal pull-request action, adds a repository-target GitHub connection rebind, and records backup/restore failures. The earlier `503` on `/api/ready/scans` in the same rollout was the worker-promotion admission stop. D5 remains deferred. [PRD §8](./PRD.md#current-deployed-production--2026-11-16-record-released-2026-11-15-2216-utc) records the evidence and limits.

The first positive fix receipt was observed on that tuple on 2026-11-16 in workspace `cmrtq1zdx00000124rxffgrlg`: finding `cmvnr1oa700140nx3viidm6s2` (`symfony/process@6.4.32`, GHSA-r39x-jcww-82v6) → proposal `cmvqrgyph000001mb88l5t2pz` → [fix PR #1](https://github.com/ecryptoguru/lyrashield-php-acceptance-20261025/pull/1) merged as `30b4d018e1d4abbb69c311008a664b4a36ebe975` → deterministic retest `cmwiksnuo000501fu43qj89bx` → `FIXED`/`VALIDATED`, `llmRequests: null`. This is deterministic SCA evidence on the PHP fixture, not a paid model-backed acceptance; `sast` and `iac` stay `BLOCKED` there, and hosted tenant/MCP, physical-device/screen-reader and financial qualification remain open. [PRD §8](./PRD.md#fix-pr-and-deterministic-retest-acceptance--2026-11-16) records the identities and limits.

Superseded releases, each verified at the time and retained in git, [PRD §8](./PRD.md#8-current-production-evidence) and [codebase §11](./codebase.md#11-production-topology-and-accepted-evidence): 2026-11-15 recovery `9faf5a903` ([release 43700283334](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43700283334)); 2026-11-02 `b03f0bbe2` ([41518076035](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/41518076035)) and nonbilling `d488862bd` ([41438792830](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/41438792830)); 2026-10-31 `6739563df` ([41117355986](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/41117355986)); 2026-10-27 `2d4e168da` ([40538483543](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40538483543)); 2026-10-25 isolated restore [40172080687](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40172080687). Do not rerun the billing-blocked [40202231545](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40202231545). None establishes paid acceptance, a model-backed Fix PR/retest, physical-device or screen-reader qualification, or financial readiness. Preserve failed receipts; never infer a fix or rewrite evidence.

Three reconciliation/catalog alert rules remain intentionally disabled under the October 12 noise policy; the operator receiver is verified and one controlled test notification was delivered, which does not prove individual rule behaviour.

Recheck deployed state before operational action. Current open gates and follow-up work are owned by [PRD §9](./PRD.md#9-release-status); dated handoffs under `docs/handoffs/` must have their source and evidence refreshed before use. Do not create production scorecards, perform live financial actions, or run paid acceptance scans without explicit authorization. Keep unverified findings `DETECTED` or `INCONCLUSIVE`.

## Founder decisions

Open: trademark clearance; confirm the current public Cloud-admission posture and authorize each live checkout/refund proof. Local admission remains off.

Decided 2026-09-22: publish the existing Cloud and minute-pack prices unchanged; keep repository MCP/WebMCP findings visible on Trial and Starter; use the fixed OnboardingAI2 revision with the production Deep profile for controlled acceptance; allow capability-bound release-identity confirmation returning only `MATCH`, `MISMATCH` or `UNAVAILABLE` without disclosing the stored identity. None of these authorizes a new live charge, cancellation or refund. [PRD §10](./PRD.md#10-founder-decisions) owns the detail.

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
- Production pgcrypto lives in the `extensions` schema. Migrations that need `public.digest` must include the ordered, idempotent compat shim; CI replays the full chain into a production-shaped database so the ordering cannot regress.

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
- `provision-alerts.sh` uses only the operator-approved Ankit primary inbox and excludes `reconciliation-backlog`, `reconciliation-duplicates`, and `webhook-catalog-rejection` from provisioning until their paid evaluations are explicitly approved. Readback must verify the enabled provisioned rules and operator action group. Keep `app-any-5xx` enabled for telemetry with no email actions and preserve sustained 5xx/outage coverage. Never provision `scan_worker_lease_expired` without a durable counter. Use the plan-first `ops/monitoring/reduce-noise.mjs` for scoped notification changes; do not run the full provisioner as cleanup.
- `pnpm --filter @lyrashield/worker verify:launch-assurance` is dry-run-first and read-only by default; mutation requires exact scan/workspace IDs, the production confirmation phrase, authenticated cancellation, and shared queue recovery only. The script is defined only in `apps/worker/package.json`, so it must be run through the filter.
- Direct updates must not set `FIXED`; retain `FIXED_PENDING_RETEST` until trusted retest receipt.

### Queue, worker, and network

- Queue authority is `packages/integrations/src/queue.ts`; use `enqueueScan()` and `getScanQueue()`.
- Treat BullMQ job identity and data as untrusted: require `job.id === scanId`, then bind
  workspace, target, goal, mode, and policy back to the stored scan before execution.
- Never create one-off queues, delete BullMQ keys directly, or auto-requeue ambiguous paid work.
- Worker heartbeat and readiness use single-key Lua operations. Keep the admission-stop `EXISTS` check separate because its key is in a different Redis Cluster slot.
- Reconcile unconditionally at worker start; on five-minute ticks, inspect BullMQ when the DB has nonterminal scans, at least hourly while idle, and whenever the DB preflight is uncertain. Never turn that uncertainty into a skipped reconciliation.
- Invoke the engine for `REPO` scans only. URL/API launch supports deterministic Safe/Quick only; engine-backed Standard/Deep/Custom URL/API profiles are removed from the launch offering and require a future explicit product decision. Engine target traffic requires current domain verification and a scan-scoped relay grant. The remote relay rejects opaque CONNECT tunnels; the sandbox-local TLS adapter uses the installed sandbox CA for HTTPS clients. Composed local curl and Chromium navigation/fetch tests passed allowed requests and denied path/method/redirect requests without disabling TLS validation. Exact-image production deployment and a paid URL engine scan remain unverified.
- `REDIS_URL` is BullMQ TCP; `UPSTASH_REDIS_REST_URL/TOKEN` are rate limiting. Never interchange them.
- Keep worker and engine child on the same protected, host-visible `TMPDIR`; pre-create
  local bind roots with restrictive permissions and never recursively chown a predictable
  shared `/tmp` path.
- Meter agent-minutes only after a scan-bound completed receipt or scan-bound affirmative
  provider usage. Deterministic URL/API scans and pre-provider failures are non-billable.
- Set `TRUSTED_PROXY_IP_HEADER` only when ingress strips incoming copies and writes the authoritative value.
- Keep authenticated egress proxy, DNS pinning, drain-before-restart, union rollback/fail-close, and negative egress tests intact. CISA KEV uses the proxy; a direct CISA pin is allowed only as the staged legacy route while rolling out the proxy-capable worker first.

### Models and agents

- Routing authority: `resolveEngineProfile()`; budget authority: `resolveScanBudgetUsd()`; price authority: `gpt6-pricing.ts`.
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
- `pnpm lint:md` — advisory markdownlint pass (`.markdownlint-cli2.jsonc`). No CI job runs it; invoke it by hand before a docs-heavy PR.
- `pnpm lint:knip` — manual advisory dead-code report (`knip.json`); no CI job runs it. `pnpm lint:knip:baseline` optionally rejects new unexplained findings against the reviewed `knip-baseline.json`; use both scripts during reviewed maintenance. Verify consumers before accepting a removal or baseline entry.
- `pnpm test:core` (vitest unit suite), `pnpm test:marketing`, `pnpm test:motion`, `pnpm test` (full runner), `pnpm test:e2e` (Playwright; needs the test database).
- `pnpm db:generate`, `pnpm db:migrate`, `pnpm prisma:migrate:check` (migration drift).
- `pnpm verify:worker-image` — worker image contract on the checked-out Dockerfile and host assets.
- Deploy-script suites: `node --test .github/scripts/tests/*.test.mjs` and `for t in .github/scripts/tests/*.sh; do bash "$t" || exit 1; done`. These mock `docker`/`systemctl`/`curl` and never touch a real VM.

Release pipeline — GitHub Actions only; qualifying main merges can trigger production automatically:

- `ci.yml` gates PRs targeting main. Code quality, app/core/operations and selected marketing/motion checks run in independent jobs; the final `Lint, Typecheck, Test & Build` aggregate fails on missing routing, cancellation, or failure/skip of any selected job, including Desktop frontend and selected no-push container builds. Code quality runs one lint and one typecheck invocation over the union of selected workspace dependency closures; app runtime prepares SDK/MCP/plugin build prerequisites through the canonical plugin build closure before the full core suite, independently of static quality. Known stylesheet/static-image/font changes keep app builds and the DB-free portable browser harness; executable or unknown inputs remain conservative. Every job declares its own `timeout-minutes`. Security owns the per-PR gitleaks run; the reusable diff gate avoids its duplicate on this repository's PRs. No-push container qualification selects packaging/build-environment inputs and copied worker host assets; ordinary source/test/style changes use required host checks. Production independently builds and verifies exact release images before deployment.
- `release-production.yml` runs on main pushes. Its read-only `qualify-release-source.mjs` guard requires the latest genuine CI attempt, the three successful required checks and an immutable tested base/head/merge receipt whose tree matches the normal or squash merge. Optional running or failed jobs do not block qualification once all three required contexts succeed; queued, cancelled, unsupported or malformed workflow states and missing, stale, pending or ambiguous required evidence fail closed. Deployment routing then compares successful deployed baselines and calls Azure and marketing independently without repeating PR tests. Release images are built once; Lighthouse runs separately. Worker promotion retains admission stop, refreshed secrets, empty-queue preflight, readiness and provenance checks. Manual emergency dispatch still requires current main and exact confirmation; review automatic deployment effects before authorizing a merge.
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
