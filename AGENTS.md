# AGENTS.md — LyraShield AI orientation

Start here. This file is the current handoff and execution queue; `codebase.md` is the implementation map and `PRD.md` Part C is the product/backlog and release-readiness source of truth. Code and schema always beat documentation.

## Repository

LyraShield AI is the evidence-backed release-assurance layer for AI-built software. Its loop is **Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report**. Findings remain detected until independent verification evidence exists, clean deterministic retests are described as retest-confirmed, and PR execution is a guarded future step that requires a server-generated patch and exact approval binding.

LyraShield is **one app, two modes** — Cloud (subscription, hosted) and Local (BYOK desktop, one-time license). Both share the same engine and core loop. Cloud sync is the optional bridge from Local to Cloud.

- `apps/web` — Next.js 16 dashboard, billing, affiliate dashboard, license/sync API, and approval-gated API/MCP actions
- `apps/worker` — BullMQ scan worker, schedulers, scanners, engine runner
- `apps/desktop` — Tauri v2 desktop app (Rust core + React frontend) for Local/BYOK mode with OS keychain credential storage, ed25519 license verification, optional cloud sync
- `apps/marketing` — Astro 7 / Cloudflare Workers marketing site
- `apps/marketing-motion` — deterministic Three.js assurance-world motion workspace (production tooling; the Astro site consumes rendered posters/clips)
- `packages/*` — auth, config, credentials, db, egress-proxy, integrations, logger, MCP, score, security, types, UI, agent-rules, cli-alias, plus the CLI/agent-install stack (`packages/cli`, `packages/agent-registry`, `packages/agent-plugin`, `packages/sdk`), plus Sprint 10 packages (`packages/billing`, `packages/licenses`, `packages/pricing`, `packages/affiliate`, `packages/eval-ai-safety`, `packages/evidence-storage`). `packages/credentials` is the single source of truth for `~/.lyrashield/credentials.json` — its location, env-over-file precedence, default API URL, and normalization — shared by the CLI and MCP server so the two cannot drift; both bundle it via `noExternal`, so it stays private.

Do not rename the `@lyrashield/*` package scope or `LYRASHIELD_*` variables without founder approval. Public copy uses **LyraShield AI**; the canonical marketing domain is **`lyrashieldai.com`**. Trademark clearance remains a founder/legal decision.

## Current verified state — 2026-08-21

- **Product status:** LyraShield AI is live in **open beta with open registration**. Access is via **create a free account** at `https://app.lyrashieldai.com/sign-up`; the marketing email form is an optional product-updates subscription, not an access gate. Never describe the product as pre-launch or invite a reader to join a waitlist. The `waitlist` route, D1 table, `WAITLIST_RL` binding, and `WAITLIST_IP_SALT` secret keep their implemented names — those are code-level identifiers, not status copy.
- **One app, two modes:** Cloud (subscription, hosted, we pay LLM costs) and Local (BYOK desktop, one-time license, customer's own AI — zero LLM COGS). Both share the same engine and core loop. Cloud sync is the optional bridge.
- **Sprint 10 — Cloud billing, BYOK Local/Desktop, and Affiliate program (merged Aug 2026):** three tracks merged to `main` with a shared schema foundation. See `codebase.md` §§71–76 for the full implementation map.
  - **Track A (Cloud billing):** `packages/billing` (Polar + Razorpay dual-gateway, 14-day trial, plan-based entitlements, usage metering with agent-minutes and Deep 3× multiplier, minute packs, overage, 15-min grace period, geo-routing), `packages/pricing` (TRIAL/STARTER/PRO/TEAM/AGENCY plans, minute packs, local SKUs), billing routes in `apps/web/src/app/billing/` (checkout, webhook, portal), entitlement gating at scan creation via `assertScanAllowed()`. 9 migrations under `packages/db/prisma/migrations/` (`20260818*` and `20260819*`). `STARTER` added to `WorkspacePlan` enum. New models: `MinutePack`, billing fields on `Workspace`/`BillingAccount`.
  - **Track B (BYOK Local/Desktop):** `apps/desktop` (Tauri v2, Rust core + React frontend, ed25519 license verification, OS keychain BYOK credentials, optional cloud sync), `packages/licenses` (signed license sign/verify, golden-license test vector), license activation/verify/sync endpoints in `apps/web/src/app/api/licenses/` and `apps/web/src/app/api/sync/`, Azure Key Vault integration for production signing (`apps/web/src/lib/licenses/license-service.ts`), desktop release pipeline (`.github/workflows/release-tauri.yml` — macOS universal + Windows, code signing, notarization, signed updater manifest). New models: `License`, `LicenseActivation`, `LicenseKey`, `SyncCursor`, `LicenseRevocation`.
  - **Track C (Affiliate):** `packages/affiliate` (commission engine: 25% recurring Cloud, 30% at 10+ active, 20% one-time Local; attribution: last-click cookie + promo code; fraud controls; payout ledger: RazorpayX/Payoneer), affiliate dashboard at `apps/web/src/app/affiliates/` (landing, apply, dashboard, links, commissions, payouts, activity), webhook dispatch from billing webhook to affiliate commission handlers. New models: `Affiliate`, `AffiliateProgram`, `AffiliateLink`, `Click`, `AttributionToken`, `AffiliateSubscription`, `Conversion`, `Commission`, `Payout`, `PayoutItem`. Terms version: `2026-08-18-v1`.
  - **Security remediation:** 41 CRITICAL/HIGH + 57 MEDIUM/LOW issues fixed across all three tracks. See `.devin/plans/sprint-10-medium-low-findings.md`.
- **AI App Security and assurance work:** the browser-local deterministic scanner, AI-03 foundation, private score isolation, Evidence Vault, profile, and threat-model foundations are implemented. `packages/eval-ai-safety` evaluates the PromptInjectionGuard against OWASP Gen AI (34 test cases) and MLCommons AILuminate (1,200 prompts). `packages/evidence-storage` provides AES-256-GCM envelope encryption. The release state for each capability is the evidence matrix in `docs/plans/2026-08-13-ai-app-security-scanner.md`; do not describe partial features as released.
- **Sprints 0–9, agent actions, SCA/secrets/URL scanning, reports, schedules, notifications, MCP, GitHub diff gate, reliability/tenant-safety hardening, social distribution loop, scorecards, referrals, UX V2, OAuth/MCP marketplace, and blog program (161 articles)** are merged on `main`. See `codebase.md` §§17–70 and PRD.md Part C for the full history.
- **Engine:** controlled LyraShield derivative of Strix, version `1.2.0` over pinned Strix `v1.5.3`. Product policy in `lyrashield/**` and `lyrashield_adapter/**`; two hard-gated upstream seams. `scripts/verify-controlled-derivative.sh` enforces footprint, Ruff, formatting, pytest, mypy, Bandit. GPT-5.6 Terra/Luna only; Safe/Quick/Standard → Luna/medium; Deep/Custom → Terra/medium coordinator + Luna/high specialists. Per-scan caps: $1.20/$1.20/$3.20/$5/$5. Private ledger retains engine telemetry; dashboard exposes no costs.
- **First approved production Standard scan (2026-07-29):** Standard/Luna scan against `ecryptoguru/OnboardingAI2`, 6m 53s, $1.78, 40 findings, tamper-evident manifest saved. Deep/Terra proof remains a separate gate.
- **Marketing:** deployed and indexable at `https://lyrashieldai.com` with D1/Rate Limit/KV bindings, sitemap/robots/`llms.txt`, security headers, PostHog. Lite Scanner live at `https://scanner.lyrashieldai.com`. Authenticated app live at `https://app.lyrashieldai.com` with open registration.
- **Agent plugin:** `@lyrashield/agent-plugin` v0.1.17 with Cursor streamable-http support. `packages/agent-registry` covers 30 entries across 24 distinct agents. 4 confirmed client shims: Claude Code, Cursor, OpenAI Codex, Kiro.
- PR CI runs core, marketing, motion, and Chromium E2E suites plus lint, typecheck, production build, formatting, Prisma client generation, migration drift/application, SCA/secret scanning, RLS reproduction, and pinned-engine provenance/worker contract gate. Desktop CI builds (Tauri macOS + Windows) run on PRs touching `apps/desktop`; `release-tauri.yml` handles production desktop releases. `git diff --check` remains a required local/review check. Local Docker Compose builds `web`, `migrate`, and `worker` images and starts a healthy full stack.
- **Production recovery and egress (2026-08-21):** PR #377 added Prisma client generation to the isolated restore drill; a manual run completed encrypted backup, restore, schema/RLS/audit verification, and application startup. PR #376 added the digest-pinned egress-proxy image and Azure deployment hook. The production proxy now uses a system-managed identity with a Key Vault secret reference, allows ingress only from the dedicated worker VM, and the worker was refreshed through its existing DNS-pinned egress policy; external proxy health requests are denied. Redis ingress is narrowed to the Container Apps environment and worker VM, but the current Redis endpoint is still public and non-TLS, so the private/TLS Redis release gate remains open.

## Current execution queue

### 1. Controlled scan release gate

Owner: engineering + founder authorization.

1. Standard/Luna scan completed (2026-07-29). Deep/Terra still needs its own approved run.
2. Promote only an inspected sandbox image digest. Production image provenance and approval remain separate operational gates.
3. Complete the remaining full-scan runtime gate: BullMQ-compatible private/TLS Redis and any outstanding private S3/evidence proof. Dedicated worker compute and the authenticated Next.js application origin are live; transport-level egress is deployed separately.
4. Keep Docker health, engine CLI availability, local sandbox execution, and production controlled-scan proof as separate claims.

### 2. Sprint 10 production provisioning

Owner: engineering + founder.

Sprint 10 is merged to `main`. The remaining work is **production provisioning only**:

- Polar and Razorpay test credentials, product/price IDs, webhook secrets, signed webhook smoke, and non-charge test objects are configured. Live paid activation remains a separate founder-controlled payment decision.
- Provision Azure Key Vault for license signing (`lyrashieldprodsecrets`).
- Verify entitlement gating and usage metering end-to-end against live provider events.
- Provision RazorpayX and Payoneer payout API credentials for affiliate payouts.
- Set up tax-form verification workflow (W-9/W-8BEN/W-8BEN-E/GSTIN).
- Do not publish draft pricing until founder-approved.

### 3. Production observability and recovery

Owner: engineering.

Backup/restore is proven by the 2026-08-21 encrypted backup and isolated restore drill. Continue with worker cancellation, queue recovery under production failure injection, capacity, and incident ownership evidence in the target environment.

### 4. Deployment defense in depth

Owner: engineering / infrastructure.

Transport-level egress control with DNS pinning is deployed through the worker-only proxy. Complete private/TLS Redis and the remaining production data/evidence, monitoring, and capacity gates before expanding untrusted scan exposure.

### 5. Marketing launch gate

Owner: founder + marketing + engineering.

1. **Done:** `https://lyrashieldai.com` is the canonical marketing origin; trademark clearance remains separate.
2. **Done:** production D1, Rate Limit, KV, and `WAITLIST_IP_SALT` bindings are provisioned; D1 migrations applied remotely.
3. **Done:** the indexable marketing Worker is deployed; apex TLS, waitlist/referral APIs, canonical metadata, sitemap/robots/`llms.txt`, schema, security headers, and mobile Lighthouse/desktop Brave QA pass.
4. **Done:** `www` permanently redirects to apex with path and query preservation.
5. **Done:** GitHub Actions auto-deploys marketing-impacting `main` changes only after security and full release gates. Rotate the Cloudflare token before July 16, 2027.
6. **Done for the passive Lite Scanner:** `PUBLIC_SCANNER_URL` points to the separately protected Azure Container App, Turnstile and the monitored abuse route are live, `/scan` is enabled and indexable.
7. **Done for open registration:** `PUBLIC_APP_URL` is set to `https://app.lyrashieldai.com`, the authenticated app accepts email and configured OAuth sign-up, and marketing CTAs link to sign-up/sign-in. Separately verify scorecard metadata, all card formats, badge output, revocation/expiry 404s, referral attribution, and human-event deduplication.

## Deferred roadmap

- Security Copilot sidebar and visual security plan/recap
- Compliance-lite evidence packs
- IaC, container, and reachability scanning
- Enterprise identity, SCIM, advanced policy, private worker, VPC/self-hosting
- Local/self-hosted model support for the BYOK desktop app (engine requires GPT-5.6 Terra/Luna today)

## Founder decisions still needed

- Trademark clearance for the confirmed `lyrashieldai.com` public domain
- Public-launch timing
- Authorized model/provider and first controlled Deep/Terra scan target
- **`eval-exec` gate severity (self-flagged 2026-07-31, never confirmed):** `packages/cli/src/diff-core.ts` classifies `eval`/`exec` usage in a diff as `MEDIUM` (was `HIGH`); `action.yml`'s equivalent risky-pattern check was already `MEDIUM`. Both `lyrashield gate` and the GitHub Action default to `--fail-on HIGH`, so an `eval()`/`exec()` addition in a diff will not fail either gate by default. Needs an explicit founder call: keep both at `MEDIUM` (current state) or raise both to `HIGH` (stricter default).

## Non-negotiable implementation rules

- Never push directly to `main`; use a focused branch and PR.
- Scope every workspace query by `workspaceId`, validate input with Zod, use `@lyrashield/logger`, and write audit events for sensitive operations.
- Use shared UI components and typed API helpers; inspect rendered UI for frontend changes.
- Verify relevant work with `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check`. Add security regression coverage for security controls.
- Keep public claims honest: no benchmark/accuracy claims, pricing, customer claims, or public mention of the forked engine.
- **Claims discipline:** do not add "SOC 2 compliant," "certified," "guarantees security," "AI safety tested" (without a named framework), or "adversarial robustness proven" to any public copy, UI, API description, or report. See `docs/claims-readiness.md` for what each claim requires, what is honest today, and the sequencing to get there. Before adding any new marketing copy, grep for these terms and confirm the copy does not imply certification, compliance, universal security, or adversarial robustness.
- **Money is `Decimal`, never Float.** All monetary fields use `Decimal @db.Decimal(19,4)`. All IDs are `cuid`. Idempotency everywhere (webhooks + payouts + usage records).
- **License signing:** production signing uses Azure Key Vault via managed identity. Fails closed if vault unreachable. Never embed LyraShield model keys in the desktop app — it runs only on customer-supplied credentials.

## Landmines

- `SOFT_DELETE_MODELS` and `WORKSPACE_SCOPED_MODELS` must include only Prisma models that actually have the corresponding column. `WorkspaceMember` and `OnboardingState` are deliberately excluded from automatic workspace scoping.
- Workspace context uses `AsyncLocalStorage`; never replace it with module-level state. For database RLS, use `withWorkspaceRLS(workspaceId, fn)` so `SET LOCAL` stays connection-safe.
- Keep the `Schedule.targetId` foreign key migration. Worker-created notifications are workspace-level and must not disappear behind a default `userId` filter. Use `createAndSendNotification` rather than duplicating its create/send loop.
- The engine is a controlled derivative: do not perform mechanical Strix-to-LyraShield rewrites or move generic upstream plumbing without a concrete requirement. Never bypass engine CI gates, force-push, or resolve conflicts automatically.
- Cloudflare marketing deployment must use Astro's generated `dist/server/wrangler.json`; root `wrangler.jsonc` is for bindings and build configuration.
- **Audit logging**: create audit logs through the extended Prisma client (`prisma.auditLog.create()`). Do not write audit events inside a broader Prisma transaction; the extension owns the advisory-locked chain transaction. Any mutation of hashed fields requires a locked chain rebuild.
- **Evidence**: every `Evidence` record must go through `uploadEvidence()` with a valid `encryptionKeyRef` and checksum. Missing/unavailable storage is a hard failure; never restore `encrypted://` placeholders. `packages/evidence-storage` uses AES-256-GCM envelope encryption ("LSEV1" format); fail-closed key management.
- **Proxy trust**: set `TRUSTED_PROXY_IP_HEADER` only when ingress strips incoming copies and writes the authoritative client IP. Geo-routing for billing trusts `cf-ipcountry` only when this is configured.
- **Prompt-injection guard**: use `PromptInjectionGuard` and `normalizeInput()` for any new model-facing input checks; do not reintroduce ad-hoc regex bypasses.
- **Queue and scan job**: use `enqueueScan` and `getScanQueue` from `packages/integrations/src/queue.ts`; do not create one-off `Queue` instances or duplicate scan-enqueue logic in web/agent/worker.
- **Engine boundary**: invoke the external engine only for `REPO` targets. URL targets use the pinned deterministic URL scanner until the engine has an equivalently pinned transport contract.
- **Engine output**: keep artifact byte limits and parser field/count limits. Treat engine output as untrusted; only trusted verifier evidence may set a finding to verified.
- **Result integrity**: confidence is triage metadata, never proof. Persist new scan claims through the result manifest, coverage receipt, candidate, and verification-receipt boundaries. A clean retest is `VALIDATED` only when the originating deterministic scanner had complete coverage; engine-only retests are `INCONCLUSIVE`. Direct status updates must not set terminal `FIXED`; retain `FIXED_PENDING_RETEST` until the server-owned retest records its receipt.
- **GitHub installations and Fix PRs**: never create a workspace integration from callback state alone, and never accept a client-authored patch, branch, title, or body for PR creation.
- **Model accounting**: keep model selection in `resolveEngineProfile()`, protected limits in `resolveScanBudgetUsd()`, and official GPT-5.6 rates in the versioned `apps/worker/src/engine/gpt56-pricing.ts` rate card. Do not bypass positive policy validation, remove the fallback model, or claim that mode routing is a within-scan Luna→Terra cascade.
- **Public sharing analytics**: use the strict `/api/scorecards/events` allowlist and `recordScorecardEvent()`. Do not put target/repository/finding data, raw IPs, user agents, or user-authored captions into `ScorecardEvent`.
- **Scorecard payload**: `buildScorecardPayload` in `packages/db/src/score-service.ts` is the ONLY place a public payload may be constructed (its allowlist regression test is load-bearing); never add fields to it casually, and never derive share-eligibility client-side.
- **Production database migrations:** the Azure deploy workflow runs `prisma migrate deploy` before the container image update. New migrations must be additive/backward-compatible with the currently running image. Container revision rollback never reverses a Prisma migration; recovery is forward-only unless an explicit database recovery plan is executed.
- **RLS runtime role**: `DATABASE_URL` must connect as a role with `rolsuper = false` and `rolbypassrls = false`. `FORCE ROW LEVEL SECURITY` does not bind superusers or `BYPASSRLS` roles. All 30 tenant-scoped tables (21 workspace + 9 child) carry fail-closed RLS policies. Verify with `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;` — both must be `false`. See `docs/deployment/PRODUCTION_DEPLOYMENT.md` §2.
- **Redis architecture separation:** `REDIS_URL` (redis://) is for BullMQ job queue only. `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (HTTPS REST) are for distributed rate limiting only. The two are never interchangeable.
- **Email verification:** `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION` is validated at boot in `packages/config/src/env.ts`. Production Container App secrets for Brevo are not yet provisioned — production still runs with verification disabled.
- **Billing webhook idempotency:** the single webhook route at `apps/web/src/app/billing/webhook/route.ts` handles Polar and Razorpay. It inserts a `WebhookEvent` (idempotent on `@@unique([provider, externalId])`) before processing Track A/B/C. Never process a webhook without first recording the event.
- **License revocation:** revoked licenses never ride perpetual fallback (RISK-B1). The desktop app hard-stops on revocation. `verify_stored_license()` must contact the server to check revocation status.
- **Affiliate commission precision:** all commission amounts use `Decimal @db.Decimal(19,4)`. The annual rate is flat 25% — the 30% tier kicker applies to monthly only (founder-confirmed 2026-08-19). No commission on minute packs, trials, or self-referrals.

## Repository boundaries and generated artifacts

- `lyrashield-engine` (sibling repo) owns the Python scanner/runtime implementation; product code in this repo only invokes it through the worker.
- `lyrashield-marketplace` (sibling repo) owns published public install artifacts; generation source lives here in `packages/agent-plugin` and `docs/marketplace`.
- `lyrashieldai` (this repo) is the authoritative source for product, auth, API, dashboard, MCP, installer source, and generation/conformance checks.
- `@lyrashield/cli` is deprecated; the canonical published CLI is the unscoped `lyrashield` package.

Build artifacts and generated media are **not kept in this repo**.

- `apps/web/.next/`, `apps/marketing/dist/`, `packages/*/dist/`, `.turbo/`, `apps/marketing-motion/renders/`, and `apps/marketing/public/media-local/` are generated and `.gitignore`d.
- Heavy media masters/renders are archived to remote storage (R2) or regenerated by the `apps/marketing-motion` workflow.
- Run `pnpm install` and `pnpm build` as needed; do not commit `node_modules` or build output.

## Documentation ownership

- `PRD.md` — strategy, authoritative backlog, accepted/rejected work; Part C is current status
- `codebase.md` — architecture, code map, implementation history (§§1–76)
- `AGENTS.md` — current state, execution queue, rules, and landmines (this file)
- `product.md` — current positioning and founder decisions
- `userguide.md` — complete end-user workflows, options, result language, roles, and limitations
- `monetization.md` — business model, pricing, affiliate terms, and decision register
- `apps/marketing/README.md` / `BLOG_AUTHORING.md` — marketing operations and publishing rules
- `docs/deployment/*` — local and production runbooks
- `docs/ops/*` — operations runbooks (license signing, desktop release, Tauri updater, RLS verification)

After a PR merges, remove branch-only wording and record the PR/merge truth here, in `PRD.md` Part C, and in the relevant dated `codebase.md` section. Do not update historical checkpoint counts except when explicitly labeling them as current.
