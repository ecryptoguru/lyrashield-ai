# AGENTS.md — LyraShield AI orientation

Start here. This file is the current handoff and execution queue; `codebase.md` is the implementation map and `PRD.md` Part C is the product/backlog and release-readiness source of truth. Code and schema always beat documentation.

## Repository

LyraShield AI is an agent-native application-security platform for AI-built software. Its loop is **Target → Scan → Verified Finding → Fix PR → Retest → Report**.

- `apps/web` — Next.js 16 dashboard
- `apps/worker` — BullMQ scan worker
- `apps/agent` — approval-gated agent actions
- `apps/marketing` — Astro 7 / Cloudflare Workers waitlist site
- `packages/*` — auth, config, db, integrations, logger, MCP, score, security, types, UI

Do not rename the `@lyrashield/*` package scope or `LYRASHIELD_*` variables without founder approval. Public copy uses **LyraShield AI**; the public domain remains undecided.

## Current verified state — 2026-07-14

- Sprints 0–7, the agent action layer, SCA/secrets scanning, URL scanning, reports, schedules, notifications, MCP, the GitHub diff gate, reliability/tenant-safety hardening, and the social distribution loop are merged on `main`. GPT-5.6 routing/caps merged in PR #53; Deep Review v3 remediation merged in PRs #54–#57; deletion attribution and legacy-report fallback landed in PR #59; the premium UI and Assurance Story release is PR #60.
- **LyraShield Score + public scorecards + referrals (spec Phases 0–2)** are implemented (PR #43 plus post-review fixes): pure versioned score engine in `packages/score`, immutable `ScoreSnapshot` per completed scan, frozen-allowlist public scorecards with supersession notices and OG images, RBAC- and audit-gated share create/revoke, new-account-gated referral attribution with idempotent dual-sided agent-minute rewards, and the Phase 0 waitlist referral ladder. Landmines: `buildScorecardPayload` in `packages/db/src/score-service.ts` is the ONLY place a public payload may be constructed (its allowlist regression test is load-bearing); never add fields to it casually, and never derive share-eligibility client-side. See `codebase.md` §33.
- **Social distribution loop** is merged in PR #52: dynamic per-scorecard Open Graph/Twitter metadata; deterministic grade/fix cards in 1200×630, 1080×1080, and 1080×1350 formats; native/LinkedIn/X/Bluesky/WhatsApp/Reddit/email/copy/download sharing; revocable README badges; public conversion CTA; channel-preserving referral attribution; deduplicated privacy-safe view/share events; dashboard funnel counts; waitlist sharing/position; and client-handoff report copy. Public scorecard analytics never store target, repository, finding, IP, user-agent, or caption data. See `codebase.md` §34.
- **Premium UI and Assurance Story reports (PR #60)**: the dashboard, auth, public scorecards, shared reports, and Astro marketing site use one responsive light/dark design system; the mobile app shell uses accessible Sheet navigation; the command center renders score, severity, trend, and remediation visuals; and executive/developer/compliance reports render immutable creation-time snapshots with privacy-redacted public sharing. See `codebase.md` §37.
- Auth and routing review completed: sign-up/sign-in now handle email verification, redirect via `callbackURL`, and avoid `useSession` atom issues in `apps/web/src/app/sign-in/page.tsx` and `apps/web/src/app/sign-up/page.tsx`.
- `pnpm test` passes **711 tests in 69 files** and `pnpm test:e2e` passes **2 Chromium tests**. Lint, typecheck, production build, formatting, `git diff --check`, the production dependency audit, and rendered desktop/320px browser QA pass locally. PRs #54–#57 also passed CI migration drift/apply, lint, formatting, typecheck, tests, build, Chromium E2E, SCA/secrets, and the security diff gate.
- The engine thin fork is merged in [engine PR #1](https://github.com/ecryptoguru/lyrashield-engine/pull/1). It keeps the Strix upstream contract, defaults telemetry off, and syncs only through reviewable PRs. The engine gate passed 155 tests plus Ruff, formatting, headless mypy, and Bandit.
- The worker image builds the sibling engine source, exposes the CLI on `PATH`, and fails before sandbox setup when model configuration is missing. A controlled scan still requires authorized model credentials and an approved target; do not claim one was run.
- **Azure AI / GPT 5.6 mode routing and spend caps are implemented**: Safe/Quick/Standard scans select `LYRASHIELD_LUNA_LLM` at `medium` reasoning; Deep/Custom select `LYRASHIELD_TERRA_LLM` at `high`. `LYRASHIELD_LLM` remains the backward-compatible fallback. Default engine caps are $1.20, $1.20, $3.20, $15, and $15 respectively; a positive workspace `Policy.maxBudgetUsd` overrides the mode default. The chosen model/reasoning and budget cap are retained as scan events. Azure credentials and endpoints remain shared through `AZURE_AI_*`, `AZURE_OPENAI_*`, or generic `LLM_*` variables.
- The marketing site is implemented. Its metadata, sitemap, robots, JSON-LD, and social URLs share one build-time origin; indexable builds require public HTTPS. Pre-launch previews are noindex and return 404 for `llms.txt`. See `apps/marketing/README.md`.

### Recent hardening and infrastructure merge

- **Deep Review v3 — identity and tenant controls (PR #54)**: agent approvals are consumed exactly once with atomic execution state; account deletion anonymizes referral/scorecard attribution; production requires an explicit trusted proxy IP header; RLS documentation and growth-table ownership tests match the actual service boundary.
- **Deep Review v3 — scan pipeline and MCP (PR #55)**: non-repository targets explicitly skip repository scanners; OSV calls are deduplicated/batched and source walks are bounded/symlink-safe; scanner phases and shutdown are time-bounded; infrastructure exits are categorized; evidence retries are idempotent. MCP mutating tools require interactive approval on the controlling terminal and fail closed when no terminal is available; stdout remains JSON-RPC-only.
- **Deep Review v3 — immutable truth and cost controls (PR #56)**: reports render immutable creation-time snapshots; launch readiness uses unpaginated database aggregates; scorecard publish responses return persisted counters; policy budgets are clamped by `PLATFORM_MAX_SCAN_BUDGET_USD` (default $50), and reported overages are retained and warned after execution.
- **Deep Review v3 — sharing and workflow edges (PR #57)**: scorecard visitor deduplication uses an HMAC-signed HttpOnly cookie; supersession is workspace-scoped; channel/referral allowlists are shared; notification bulk reads are tenant/user scoped; clipboard feedback and destructive dialogs are truthful/accessibly focused; score lookup has a composite index; the gitleaks workflow scans the exact base-to-head range.
- **Deletion/report compatibility (PR #59)**: account deletion preserves terminal referral attribution status, and legacy report downloads retain their safe live-data fallback while immutable snapshots remain the default for new reports.
- **Premium UI and reports (PR #60)**: theme persistence avoids first-paint flashes, shared controls meet mobile touch targets, deterministic UTC date formatting prevents hydration drift, and report share pages are `noindex` with `Referrer-Policy: no-referrer` and generic target/title disclosure.

- **Full-flow UI QA**: Astro waitlist submission now omits absent referral codes; paginated APIs return the client-contract envelope; empty-workspace reports, notifications, and schedules render without crashing; team dates hydrate deterministically; launch readiness stays `NOT_EVALUATED` until a scan completes; and auth pages expose a main landmark.
- **Audit hash chaining**: `packages/db/src/client.ts` serializes each workspace chain with a transaction-scoped PostgreSQL advisory lock. Account deletion anonymizes user attribution and rehashes affected chains under the same lock.
- **Evidence storage**: `apps/worker/src/engine/evidence-storage.ts` uploads PoC and code-location artifacts to S3-compatible storage with `AES256` SSE and SHA-256 checksums. It fails closed when storage is missing or an upload fails; placeholder evidence is forbidden.
- **Prompt-injection guard**: `packages/mcp/src/prompt-injection-guard.ts` now normalizes input (zero-width chars, NFKC, HTML entities) and uses a tightened, expanded pattern set with explicit critical-pattern logic.
- **API client**: `apps/web/src/lib/api-client.ts` distinguishes caller cancellation from timeouts and propagates already-aborted signals.
- **Client-IP extraction**: the web app trusts only the header named by `TRUSTED_PROXY_IP_HEADER`; production ingress must strip client-supplied copies. Cloudflare marketing uses `cf-connecting-ip` and an atomic D1 fallback limiter.
- **GitHub token cache**: `packages/integrations/src/redis.ts` and `queue.ts` added; `packages/integrations/src/github.ts` caches installation tokens and `enqueueScan` is centralized.
- **Queue unification**: `apps/web/src/lib/queue.ts`, `apps/agent/src/queue.ts`, and `apps/worker/src/queue.ts` now consume `packages/integrations/src/queue.ts` (`getScanQueue`, `enqueueScan`).
- **Prettier scope**: `.prettierignore` excludes `.devin`, `.windsurf`, generated Astro/Wrangler files, and `next-env.d.ts`.
- **Privacy and E2E**: `DELETE /api/account` blocks sole owners, anonymizes loose attribution, preserves audit-chain validity, and is exposed in Settings. Playwright covers signup/signin, onboarding, target and scan creation, and cross-tenant scan/finding/report denial.
- **Operations**: `/api/health`, `/api/ready`, and Next.js request-error instrumentation are implemented. CI runs formatting and Chromium E2E. Docker contexts exclude generated output and the sibling engine virtualenv.

## Current execution queue

### 1. Controlled scan release gate

Owner: engineering + founder authorization.

1. Provision the authorized Luna and Terra deployments, set `LYRASHIELD_LUNA_LLM`/`LYRASHIELD_TERRA_LLM` plus the matching Azure credentials, and approve the first target. Keep `LYRASHIELD_LLM` as a tested fallback.
2. Pin and inspect the production sandbox image by digest; do not use a mutable tag.
3. Run the target through the full worker lifecycle and retain its scan events, findings, and audit evidence.
4. Keep Docker health, engine CLI availability, sandbox execution, and controlled-scan proof as separate claims.

### 2. Billing and usage limits

Owner: engineering + founder pricing decision.

Sprint 10 is the principal unbuilt self-serve Phase 1 feature. Confirm the provider, plan boundaries, usage metric, quotas, and retry/concurrency policy before implementation. Existing billing models and environment variables are schema foundation only; do not publish draft pricing.

### 3. Production observability and recovery

Owner: engineering.

Connect structured logs and readiness signals to the selected monitoring platform. Define alerts and incident ownership, then prove backup/restore, queue recovery, worker cancellation, and capacity in the target environment.

### 4. Deployment defense in depth

Owner: engineering / infrastructure.

Provision production data stores, evidence storage, secrets, TLS, backups, monitoring, and worker capacity. Add transport-level egress control with DNS pinning before exposing scans to untrusted targets at scale; application SSRF checks are not a substitute.

### 5. Marketing launch gate

Owner: founder + marketing + engineering.

1. Confirm the public HTTPS domain and trademark direction.
2. Replace Cloudflare D1 and Rate Limit placeholders and set `WAITLIST_IP_SALT` as a Worker secret.
3. Apply D1 migrations and build with the production `PUBLIC_SITE_URL`.
4. Deploy with Astro's generated `dist/server/wrangler.json`.
5. Verify canonical URLs, sitemap, robots, waitlist submission/referral sharing, analytics, and visual QA on the real domain. On the app origin, also verify scorecard metadata, all card formats, badge output, revocation/expiry 404s, referral attribution, and human-event deduplication before setting `PUBLIC_INDEXABLE=true`.
6. Publish only founder-approved posts; sample posts remain drafts by design.

## Deferred roadmap

- Security Copilot sidebar and visual security plan/recap
- Compliance-lite evidence packs
- IaC, container, and reachability scanning
- Enterprise identity, SCIM, advanced policy, private worker, VPC/self-hosting, and BYOK/BYOM

## Founder decisions still needed

- Public domain and trademark clearance
- Pricing, plan boundaries, usage metric, and billing provider
- Design-partner and public-launch timing
- Authorized model/provider and first controlled-scan target

## Non-negotiable implementation rules

- Never push directly to `main`; use a focused branch and PR.
- Scope every workspace query by `workspaceId`, validate input with Zod, use `@lyrashield/logger`, and write audit events for sensitive operations.
- Use shared UI components and typed API helpers; inspect rendered UI for frontend changes.
- Verify relevant work with `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check`. Add security regression coverage for security controls.
- Keep public claims honest: no benchmark/accuracy claims, pricing, customer claims, or public mention of the forked engine.

## Landmines

- `SOFT_DELETE_MODELS` and `WORKSPACE_SCOPED_MODELS` must include only Prisma models that actually have the corresponding column. `WorkspaceMember` and `OnboardingState` are deliberately excluded from automatic workspace scoping.
- Workspace context uses `AsyncLocalStorage`; never replace it with module-level state. For database RLS, use `withWorkspaceRLS(workspaceId, fn)` so `SET LOCAL` stays connection-safe.
- Keep the `Schedule.targetId` foreign key migration. Worker-created notifications are workspace-level and must not disappear behind a default `userId` filter. Use `createAndSendNotification` rather than duplicating its create/send loop.
- The engine fork is thin: do not reintroduce mechanical Strix-to-LyraShield rewrites. Its upstream workflow is PR-only and must never auto-merge, force-push, or resolve conflicts.
- Cloudflare marketing deployment must use Astro's generated `dist/server/wrangler.json`; root `wrangler.jsonc` is for bindings and build configuration.
- **Audit logging**: create audit logs through the extended Prisma client (`prisma.auditLog.create()`). Do not write audit events inside a broader Prisma transaction; the extension owns the advisory-locked chain transaction. Any mutation of hashed fields requires a locked chain rebuild.
- **Evidence**: every `Evidence` record must go through `uploadEvidence()` with a valid `encryptionKeyRef` and checksum. Missing/unavailable storage is a hard failure; never restore `encrypted://` placeholders.
- **Proxy trust**: set `TRUSTED_PROXY_IP_HEADER` only when ingress strips incoming copies and writes the authoritative client IP.
- **Prompt-injection guard**: use `PromptInjectionGuard` and `normalizeInput()` for any new model-facing input checks; do not reintroduce ad-hoc regex bypasses.
- **Queue and scan job**: use `enqueueScan` and `getScanQueue` from `packages/integrations/src/queue.ts`; do not create one-off `Queue` instances or duplicate scan-enqueue logic in web/agent/worker.
- **Model cost routing**: keep model selection in `resolveEngineProfile()` and spend defaults in `resolveScanBudgetUsd()`. Do not bypass the positive policy-budget validation, remove the fallback model, or claim that mode routing is a within-scan Luna→Terra cascade.
- **Public sharing analytics**: use the strict `/api/scorecards/events` allowlist and `recordScorecardEvent()`. Do not put target/repository/finding data, raw IPs, user agents, or user-authored captions into `ScorecardEvent`; social image/page renders are not human views.

## Documentation ownership

- `PRD.md` — strategy, authoritative backlog, accepted/rejected work
- `codebase.md` — architecture, code map, implementation history
- `AGENTS.md` — current state, execution queue, rules, and landmines
- `product.md` — current positioning and founder decisions
- `apps/marketing/README.md` / `BLOG_AUTHORING.md` — marketing operations and publishing rules
- `docs/deployment/*` — local and production runbooks

After a PR merges, remove branch-only wording and record the PR/merge truth here, in `PRD.md` Part C, and in the relevant dated `codebase.md` section. Do not update historical checkpoint counts except when explicitly labeling them as current.
