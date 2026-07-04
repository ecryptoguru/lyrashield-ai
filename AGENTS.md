# AGENTS.md — Orientation for coding agents (Codex, Cursor, Claude Code, Devin, …)

Read this first, then the two deeper docs it points to. It exists so any coding agent can pick up LyraSec and continue safely without prior context.

## What this repo is
LyraSec AI — an agent-native application-security platform for AI-built software. Core loop: **Target → Scan → Verified Finding → Fix PR → Retest → Report**. Turborepo + pnpm monorepo: `apps/web` (Next.js 16 App Router, React 19, TS 6), `apps/worker` (stub — scan engine not built yet), and `packages/{auth,config,db,integrations,logger,types,ui}`. Stack details, architecture, conventions, and a file-by-file map: **`codebase.md`** (start at §17 for the latest changes).

## Source of truth
- **Product/roadmap/backlog SSOT = `PRD.md`.** The audit findings, current build status, and the full prioritized backlog live in **PRD PART B §B13** (§B13.5 = detailed backlog, §B13.6 = backlog→sprint mapping). Do not create a separate audit doc — extend PRD.
- Code truth beats docs. When they disagree, trust the running code + schema, then fix the doc.

## Current state (2026-07-04)
- **Complete:** Sprints 0–3 + 2.5 (auth incl. email verification, RBAC enforced on mutating routes, workspaces/projects/targets/team CRUD, onboarding wizard, GitHub App integration, SSRF hardening, rate-limiting middleware, full Prisma schema + soft-delete extension).
- **Merged security/correctness fixes (Batch 1):** tenant-isolation scoping rewrite (`packages/db/src/scoping.ts`), Upstash rate-limit config, GitHub webhook idempotency, onboarding IDOR fix, GitHub install-URL slug fix. See `codebase.md` §17 and PRD §B13.2.
- **CI runs on `main`:** install → `db:generate` → migrate → lint → typecheck → **test (vitest)** → build (Postgres 16 + Redis 7 services). Keep it green.
- **Not built:** scan queue/worker/engine, findings pipeline, fix-PR, retest, reports, notifications, billing, agent/MCP layer. `apps/worker` is a stub.

## What to work on next (from PRD §B13.6)
1. **Batch 2 — DX/UX foundation:** shared component library in `packages/ui` (B3) → frontend correctness & a11y + mobile sidebar + nav-404 stubs (A8) → server-fetched `initialData` + React `cache()` (B1/B2) → pagination on list endpoints (A6) → API/fetch helpers (B4).
2. **Batch 3 — design-in contracts:** Postgres RLS + validate on CI Postgres (see landmine below); `Evidence.encryptionKeyRef` enforcement; `AuditLog` `prevHash` hash-chain (A9); cost/determinism controls + SARIF 2.1.0 + dual CVSS fields (B5/B6).
3. **Batch 4 — differentiated build (needs the worker/engine):** SCA + secrets (v1), AI-builder-aware URL scan, launch-readiness gate, plain-language findings, shareable report, MCP server + prompt-injection defense, GitHub Action diff-gate.

## Landmines — do NOT re-break these
- **Prisma model sets must match schema columns.** `packages/db/src/scoping.ts` `SOFT_DELETE_MODELS` (19) may contain *only* models with a `deletedAt` column; `WORKSPACE_SCOPED_MODELS` (17) only models with a `workspaceId` column. Adding a model without the column makes the client extension inject a non-existent field → **Prisma throws on every read**. (This was a real bug: the soft-delete set once included `WorkspaceMember`/`CredentialSet`/`AuditLog`/`Retest`, crashing `getWorkspaceMembership`.)
- **Workspace scoping is auto-active.** `requireWorkspaceAccess` calls `setWorkspaceContext(workspaceId)` (AsyncLocalStorage). `WorkspaceMember` (cross-workspace switcher) and `OnboardingState` (per-user) are deliberately excluded from auto-scoping — do not add them. Never reintroduce a module-level global for workspace context (cross-request tenant leak).
- **Postgres RLS follow-up must be connection-safe.** Prisma pooling makes a session-level `SET app.current_workspace_id` unreliable; use transaction-scoped `SET LOCAL` (or a connection-pinned wrapper) and validate against the CI Postgres. Don't ship RLS unverified.
- **Workflow files need special GitHub permission.** The Hyperagent GitHub app lacks `Workflows: write`, so agents using it get 403 writing `.github/workflows/*`. Route CI/workflow edits to a user-credentialed agent (e.g. Codex) or the repo owner.
- **Rename is partial.** Repo is `ecryptoguru/lyrasec-ai`; product is migrating LyraShield → LyraSec. **Do NOT rename** `@lyrashield/*` package scopes or `LYRASHIELD_*` env vars without founder sign-off (trademark clearance open). Keep everything domain-agnostic (`NEXT_PUBLIC_APP_URL`); public domain is undecided.
- **A4 follow-up:** store the numeric GitHub `installationId` on `Target` and match on it (webhook currently matches by `repoFullName` owner-prefix).

## Conventions (see codebase.md §14 for the full list)
- **Never push to `main` directly** — branch + PR. CI must pass.
- **Verify before "done":** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. For any security-relevant change, add a test proving the control holds.
- **Auth imports:** `@lyrashield/auth` (client) vs `@lyrashield/auth/server` (server). Scope every workspace query by `workspaceId`. Validate all input with Zod. Write audit logs on sensitive ops.
- **Honest positioning** in any public-facing text/comments/sample reports: no "only we…" claims, no benchmark/accuracy numbers, no public pricing, never name the forked scan engine publicly.
- **High-risk zones (slow down, add tests):** the scan sandbox/worker, auth/RBAC/tenant isolation, the MCP approval gates, secrets handling, billing/metering, Prisma migrations, the CI GitHub Action.
