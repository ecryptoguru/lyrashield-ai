# AGENTS.md — LyraSec AI orientation

Start here. This file is the current handoff and execution queue; `codebase.md` is the implementation map and `PRD.md` Part C is the product/backlog and release-readiness source of truth. Code and schema always beat documentation.

## Repository

LyraSec AI is an agent-native application-security platform for AI-built software. Its loop is **Target → Scan → Verified Finding → Fix PR → Retest → Report**.

- `apps/web` — Next.js 16 dashboard
- `apps/worker` — BullMQ scan worker
- `apps/agent` — approval-gated agent actions
- `apps/marketing` — Astro 7 / Cloudflare Workers waitlist site
- `packages/*` — auth, config, db, integrations, logger, MCP, security, types, UI

Do not rename the `@lyrashield/*` package scope or `LYRASHIELD_*` variables without founder approval. Public copy uses **LyraSec AI**; the public domain remains undecided.

## Current verified state — 2026-07-11

- Sprints 0–7, the agent action layer, SCA/secrets scanning, URL scanning, reports, schedules, notifications, MCP, the GitHub diff gate, and reliability/tenant-safety hardening are merged.
- `pnpm test` passes **607 tests in 48 files**; lint, typecheck, build, and `format:check` pass on `main` CI.
- The engine thin fork is merged in [engine PR #1](https://github.com/ecryptoguru/lyrashield-engine/pull/1). It keeps the Strix upstream contract, defaults telemetry off, and syncs only through reviewable PRs. The engine gate passed 155 tests plus Ruff, formatting, headless mypy, and Bandit.
- The worker image builds the sibling engine source, exposes the CLI on `PATH`, and fails before sandbox setup when model configuration is missing. A controlled scan still requires authorized `LYRASHIELD_LLM` and `LLM_API_KEY`; do not claim one was run.
- The marketing site is implemented. Its metadata, sitemap, robots, JSON-LD, and social URLs share one build-time origin; indexable builds require public HTTPS. Pre-launch previews are noindex and return 404 for `llms.txt`. See `apps/marketing/README.md`.

### Recent hardening and infrastructure merge

- **Audit hash chaining**: implemented as a Prisma client extension in `packages/db/src/client.ts`. Every `auditLog.create()` now computes `prevHash` and `hash` automatically. `packages/db/src/audit-service.ts` has been removed.
- **Evidence storage**: `apps/worker/src/engine/evidence-storage.ts` uploads PoC and code-location artifacts to S3-compatible storage with `AES256` SSE and SHA-256 checksums; `apps/worker/src/engine/finding-persister.ts` uses it for every `Evidence` record. `packages/db/src/evidence.ts` validates the `encryptionKeyRef` format.
- **Prompt-injection guard**: `packages/mcp/src/prompt-injection-guard.ts` now normalizes input (zero-width chars, NFKC, HTML entities) and uses a tightened, expanded pattern set with explicit critical-pattern logic.
- **API client**: `apps/web/src/lib/api-client.ts` uses `AbortController` for fetch timeouts; `apps/web/src/lib/api-client.test.ts` was updated to match.
- **Client-IP extraction**: `apps/web/src/proxy.ts` and `apps/marketing/src/pages/api/waitlist.ts` use the same provider-first, last-hop-in-`x-forwarded-for` logic.
- **GitHub token cache**: `packages/integrations/src/redis.ts` and `queue.ts` added; `packages/integrations/src/github.ts` caches installation tokens and `enqueueScan` is centralized.
- **Queue unification**: `apps/web/src/lib/queue.ts`, `apps/agent/src/queue.ts`, and `apps/worker/src/queue.ts` now consume `packages/integrations/src/queue.ts` (`getScanQueue`, `enqueueScan`).
- **Prettier scope**: `.prettierignore` excludes `.devin`, `.windsurf`, generated Astro/Wrangler files, and `next-env.d.ts`.

## Current execution queue

### 1. Controlled scan release gate

Owner: engineering + founder authorization.

1. Provide authorized `LYRASHIELD_LLM` and `LLM_API_KEY` values and approve the first target.
2. Pin and inspect the production sandbox image by digest; do not use a mutable tag.
3. Run the target through the full worker lifecycle and retain its scan events, findings, and audit evidence.
4. Keep Docker health, engine CLI availability, sandbox execution, and controlled-scan proof as separate claims.

### 2. Billing and usage limits

Owner: engineering + founder pricing decision.

Sprint 10 is the principal unbuilt self-serve Phase 1 feature. Confirm the provider, plan boundaries, usage metric, quotas, and retry/concurrency policy before implementation. Existing billing models and environment variables are schema foundation only; do not publish draft pricing.

### 3. Privacy and browser E2E

Owner: engineering.

Implement account deletion and the delete/anonymize policy for linked records. Add maintained Playwright coverage for authentication, onboarding, target and scan creation, finding/report access, and authorization boundaries.

### 4. Deployment defense in depth

Owner: engineering / infrastructure.

Provision production data stores, evidence storage, secrets, TLS, backups, monitoring, and worker capacity. Add transport-level egress control with DNS pinning before exposing scans to untrusted targets at scale; application SSRF checks are not a substitute.

### 5. Marketing launch gate

Owner: founder + marketing + engineering.

1. Confirm the public HTTPS domain and trademark direction.
2. Replace Cloudflare D1 and Rate Limit placeholders and set `WAITLIST_IP_SALT` as a Worker secret.
3. Apply D1 migrations and build with the production `PUBLIC_SITE_URL`.
4. Deploy with Astro's generated `dist/server/wrangler.json`.
5. Verify canonical URLs, sitemap, robots, waitlist submission, analytics, and visual QA on the real domain before setting `PUBLIC_INDEXABLE=true`.
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
- **Audit logging**: create audit logs through the extended Prisma client (`prisma.auditLog.create()`). The extension computes `prevHash`/`hash`; the deleted `audit-service.ts` is not a source of truth.
- **Evidence**: every `Evidence` record must go through `uploadEvidence()` with a valid `encryptionKeyRef` and `checksum`. `assertEvidenceEncrypted` validates both presence and key-ref format.
- **Prompt-injection guard**: use `PromptInjectionGuard` and `normalizeInput()` for any new model-facing input checks; do not reintroduce ad-hoc regex bypasses.
- **Queue and scan job**: use `enqueueScan` and `getScanQueue` from `packages/integrations/src/queue.ts`; do not create one-off `Queue` instances or duplicate scan-enqueue logic in web/agent/worker.

## Documentation ownership

- `PRD.md` — strategy, authoritative backlog, accepted/rejected work
- `codebase.md` — architecture, code map, implementation history
- `AGENTS.md` — current state, execution queue, rules, and landmines
- `product.md` — current positioning and founder decisions
- `apps/marketing/README.md` / `BLOG_AUTHORING.md` — marketing operations and publishing rules
- `docs/deployment/*` — local and production runbooks
