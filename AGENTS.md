# AGENTS.md — LyraSec AI orientation

Start here. This file is the current handoff; `codebase.md` is the implementation map, `PRD.md` is the product/backlog source of truth, and `NEXT-STEPS.md` is the short actionable queue. Code and schema always beat documentation.

## Repository

LyraSec AI is an agent-native application-security platform for AI-built software. Its loop is **Target → Scan → Verified Finding → Fix PR → Retest → Report**.

- `apps/web` — Next.js 16 dashboard
- `apps/worker` — BullMQ scan worker
- `apps/agent` — approval-gated agent actions
- `apps/marketing` — Astro 7 / Cloudflare Workers waitlist site
- `packages/*` — auth, config, db, integrations, logger, security, types, UI

Do not rename the `@lyrashield/*` package scope or `LYRASHIELD_*` variables without founder approval. Public copy uses **LyraSec AI**; the public domain remains undecided.

## Current verified state — 2026-07-11

- Sprints 0–7, the agent action layer, SCA/secrets scanning, URL scanning, reports, schedules, notifications, MCP, the GitHub diff gate, and reliability/tenant-safety hardening are merged.
- `pnpm test` passes **607 tests in 48 files**; lint, typecheck, and build pass on `main` CI.
- The engine thin fork is merged in [engine PR #1](https://github.com/ecryptoguru/lyrashield-engine/pull/1). It keeps the Strix upstream contract, defaults telemetry off, and syncs only through reviewable PRs. The engine gate passed 155 tests plus Ruff, formatting, headless mypy, and Bandit.
- The worker image builds the sibling engine source, exposes the CLI on `PATH`, and fails before sandbox setup when model configuration is missing. A controlled scan still requires authorized `LYRASHIELD_LLM` and `LLM_API_KEY`; do not claim one was run.
- The marketing site is implemented. Its metadata, sitemap, robots, JSON-LD, and social URLs share one build-time origin; indexable builds require public HTTPS. Pre-launch previews are noindex and return 404 for `llms.txt`. See `apps/marketing/README.md`.

## Current priorities

1. Billing and usage limits (Sprint 10+) remain unbuilt.
2. Before any controlled scan: authorize model credentials and a target, pin the production sandbox digest, and verify sandbox execution separately from Docker health.
3. Before marketing launch: choose the public HTTPS domain, populate Cloudflare D1/Rate Limit IDs and public build variables, run migrations, then explicitly enable indexing.
4. Transport-level egress pinning/proxying remains a deployment control; application-layer SSRF checks are not a substitute.

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

## Documentation ownership

- `PRD.md` — strategy, authoritative backlog, accepted/rejected work
- `codebase.md` — architecture, code map, implementation history
- `NEXT-STEPS.md` — only the active queue and blockers
- `product.md` — current positioning and founder decisions
- `apps/marketing/README.md` / `BLOG_AUTHORING.md` — marketing operations and publishing rules
- `docs/deployment/*` — local and production runbooks
