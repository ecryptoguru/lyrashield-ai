# LyraShield — Codebase Guide for AI Agents

> **Purpose**: This document gives AI agents (Claude, GPT, Copilot, etc.) a complete mental model of the codebase so they can navigate, modify, and extend it effectively.
>
> **New agent? Start with [`AGENTS.md`](./AGENTS.md)** (repo root) for current state, the next tasks, and the landmines — then use this file as the deep code map and `PRD.md` PART B §B13 as the backlog source of truth.
>
> **⚠️ 2026-07-05:** The GitHub repo is now **`ecryptoguru/lyrasec-ai`** (renamed from `lyrashieldai`). The product name is migrating LyraShield → **LyraSec AI**, but the in-code package scopes (`@lyrashield/*`) and engine env vars (`LYRASHIELD_*`) are intentionally **not** renamed yet (trademark clearance open) — keep using them in code. See **§17 (2026-07-04 Audit — Batch 1)**, **§18 (2026-07-05 UI/UX Premium Upgrade + Deep Code Review)**, **§19 (2026-07-05 Batch 2 Remainder + Batch 3 Design Contracts + RLS + Deep Code Review)**, **§20 (2026-07-05 Round-2 Remaining Items — ALL COMPLETED)**, **§21 (2026-07-05 Sprint 4 — Scan Orchestrator + Queue + Review Fixes)**, **§22 (2026-07-06 Batch 4 — Fix Proposals, Retests, Reports, Notifications, Schedules, Plain-Language Findings + Code Review Fixes)**, and **§23 (2026-07-06 Sprint 6/6.5 — Findings Normalization + SCA + Secrets Scanning + Scanner Orchestrator)**, and **§24 (2026-07-06 Sprint 7 — Tier 2: AI-Builder-Aware URL Scan + Launch-Readiness UI + Shareable Report/Badge + MCP Server + Prompt-Injection Defense + GitHub Action Diff-Gate)** and **§25 (2026-07-06 UI/UX Refinement Sweep + Docker Deployment Verification)** and **§26 (2026-07-06 AI Pipeline Audit Fixes + Fresh Docker Verification)** at the end for the latest merged changes; where they conflict with older sections below, §17/§18/§19/§20/§21/§22/§23/§24/§25/§26 win.

---

## 1. What Is LyraShield

LyraShield is an **AI AppSec Agent Platform** — a multi-tenant SaaS that lets users connect GitHub repos or paste app URLs, run safe AI-driven security scans, get verified findings, and generate fix PRs.

**Core product loop**: `Target → Scan → Verified Finding → Fix → Retest → Report`

**Architecture boundary**:
- **This monorepo** (TypeScript): Web platform, worker orchestration, multi-tenant workspaces, finding management, fix proposals, billing, policy, reports
- **lyrashield-engine** (separate repo, Python): AI pentesting agents, vulnerability scanning, exploit validation, CLI interface. Worker calls it as a subprocess. Clean language boundary — no engine internals are imported.

### Engine Repo Status

The engine repo has been forked from [usestrix/strix](https://github.com/usestrix/strix), rebranded, and is ready for upgrades:

- **Repo**: `lyraShield/lyrashield-engine` (separate GitHub repo)
- **Upstream remote**: `https://github.com/usestrix/strix.git`
- **Commits**: 2 (rebrand + telemetry disable + upgrade roadmap)
- **Zero "Strix" references remaining** — all renamed to LyraShield
- **CLI binary renamed**: `strix` → `lyrashield`
- **Telemetry disabled**: PostHog and Scarf telemetry off by default (`LYRASHIELD_TELEMETRY=false`)
- **Upgrade roadmap**: Documented in `UPGRADES.md` in the engine repo

### Engine Upgrade Roadmap (UPGRADES.md)

**Priority 1 — Sprint 5 (Scan Engine MVP)**:
- Structured JSON findings output (matching LyraShield's Finding schema)
- Exit code mapping (0-9 for different outcomes)
- Event streaming via stdout JSON lines
- Policy enforcement hooks (`--policy-file`)

**Priority 2 — Sprint 6 (Findings Normalization)**:
- Deterministic dedupe key generation
- Evidence packaging (HTTP req/res, screenshots)
- CVSS auto-scoring

**Priority 3 — Sprint 7 (Fix Proposals)**:
- Structured patch output with safety score

**Priority 4 — Platform Enhancements**:
- Webhook callback support
- Multi-target parallel orchestration
- Custom skill loading from platform
- Sandbox security hardening (seccomp, network isolation)

### Engine Next Steps

1. Push to GitHub: Create `lyraShield/lyrashield-engine` repo and push
2. Start upgrading: Begin with Priority 1 items (structured JSON output, exit codes)
3. Continue LyraShield platform: Build Sprint 3+ in the monorepo

---

## 2. Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Web framework | Next.js (App Router, Turbopack) | 16.2.x |
| Language | TypeScript | 6.0.x |
| Runtime | React | 19.x |
| ORM | Prisma (with @prisma/adapter-pg) | 7.8.x |
| Database | PostgreSQL | 16 (Docker) |
| Cache/Queue | Redis | 7 (Docker) |
| Auth | Better Auth | 1.6.x |
| Validation | Zod | 4.x |
| Styling | TailwindCSS (CSS-first config) | 4.3.x |
| Component variants | class-variance-authority (cva) | 0.7.x |
| Icons | lucide-react | 1.23.x |
| Monorepo | Turborepo + pnpm workspaces | 2.10.x / 11.6.x |
| Testing | Vitest | 4.1.x (176 tests, 10 files) |
| Worker | tsx watch (stub mode) | — |
| Job queue | BullMQ (planned Sprint 4) | 5.78.x |

**Key version notes**:
- TypeScript 6: `types: ["node"]` required in tsconfig, `baseUrl` is deprecated
- Prisma 7: uses `prisma.config.ts` with dotenv, requires `PrismaPg` driver adapter in client constructor (no datasource URL in schema)
- Zod 4: use `z.url()` instead of `z.string().url()`, `z.email()` instead of `z.string().email()`
- TailwindCSS 4: CSS-first config via `@theme` in `globals.css`, no `tailwind.config.js`. Premium design tokens: OKLCH color space, custom shadows (`--shadow-xs` through `--shadow-lg`, `--shadow-primary`), enlarged radii (`--radius-sm` 0.375rem through `--radius-2xl` 1.25rem), glassmorphism (`.glass`), gradient utilities (`.gradient-primary`, `.gradient-hero`, `.text-gradient`), shadow utilities (`.shadow-premium`, `.shadow-card-hover`, `.shadow-primary-glow`). All utilities have dark mode variants.
- class-variance-authority (cva): Used in `Button` and `Badge` components for variant management. Variants: Button (default/secondary/ghost/destructive/outline × sm/md/lg/icon), Badge (default/success/danger/warning/info/muted).
- lucide-react v1.x: Brand icons (e.g. `Github`) removed — use `GithubIcon` from `@lyrashield/ui` instead
- Vitest 4: Test files (`*.test.ts`) are excluded from `tsc --noEmit` typecheck via tsconfig excludes
- Next.js `output: "standalone"`: Enabled in `next.config.ts` for optimized Docker builds — produces a minimal standalone server in `.next/standalone/` that runs via `node server.js` without needing `pnpm start`

---

## 3. Monorepo Structure

```
lyrashield/
├── apps/
│   ├── web/                    # Next.js web application
│   │   ├── src/
│   │   │   ├── app/            # App Router pages and API routes
│   │   │   │   ├── (dashboard)/        # Dashboard route group (auth-protected)
│   │   │   │   │   ├── dashboard/
│   │   │   │   │   │   ├── page.tsx              # Main dashboard with stats
│   │   │   │   │   │   ├── projects/             # Project list + create
│   │   │   │   │   │   │   ├── page.tsx          # Server component (cursor pagination, initialData)
│   │   │   │   │   │   │   └── projects-client.tsx  # Client (LoadMore, apiGetPaginated)
│   │   │   │   │   │   ├── targets/              # Target list + create + detail
│   │   │   │   │   │   │   ├── page.tsx          # Server component (cursor pagination, initialData)
│   │   │   │   │   │   │   ├── targets-client.tsx  # Client (LoadMore, apiGetPaginated)
│   │   │   │   │   │   │   └── [id]/page.tsx     # Target detail page
│   │   │   │   │   │   ├── integrations/         # Integrations page (GitHub App)
│   │   │   │   │   │   │   ├── page.tsx          # Server component
│   │   │   │   │   │   │   └── github-integration.tsx  # Client: connect + repo picker (apiGet/apiPost)
│   │   │   │   │   │   ├── findings/             # Stub page (not yet built)
│   │   │   │   │   │   ├── fixes/                # Stub page (not yet built)
│   │   │   │   │   │   ├── scans/                # Stub page (not yet built)
│   │   │   │   │   │   ├── reports/              # Stub page (not yet built)
│   │   │   │   │   │   ├── settings/             # Stub page (not yet built)
│   │   │   │   │   │   └── team/                 # Team members + invites
│   │   │   │   │   │       ├── page.tsx          # Server component
│   │   │   │   │   │       └── team-client.tsx
│   │   │   │   │   ├── layout.tsx                # Dashboard layout (auth guard + onboarding redirect + sidebar)
│   │   │   │   │   └── loading.tsx
│   │   │   │   ├── onboarding/                   # Onboarding wizard (Sprint 2.5, premium UI)
│   │   │   │   │   ├── page.tsx                  # Server component (auth guard, gradient hero bg, logo badge)
│   │   │   │   │   └── onboarding-wizard.tsx     # 7-step client component (apiPost/apiPatch, premium buttons)
│   │   │   │   ├── api/                          # REST API routes
│   │   │   │   │   ├── auth/[...all]/route.ts    # Better Auth handler
│   │   │   │   │   ├── onboarding/route.ts       # GET + PATCH onboarding state
│   │   │   │   │   ├── projects/route.ts         # POST + GET projects (cursor pagination)
│   │   │   │   │   ├── targets/route.ts          # POST + GET targets (cursor pagination, SSRF)
│   │   │   │   │   ├── team/route.ts             # POST invite + GET members
│   │   │   │   │   ├── workspaces/route.ts       # POST create + GET list workspaces
│   │   │   │   │   ├── integrations/github/      # GitHub App integration routes
│   │   │   │   │   │   ├── install/route.ts      # GET callback + POST install URL
│   │   │   │   │   │   └── repos/route.ts        # GET list installation repos
│   │   │   │   │   └── webhooks/github/route.ts  # POST GitHub webhook handler
│   │   │   │   ├── sign-in/page.tsx              # Sign-in page (email + GitHub OAuth, gradient bg, premium card)
│   │   │   │   ├── sign-up/page.tsx              # Sign-up page (redirects to /onboarding, gradient bg, premium card)
│   │   │   │   ├── page.tsx                      # Marketing landing page (gradient hero, glassmorphic nav, feature cards)
│   │   │   │   ├── layout.tsx                    # Root layout (Inter font)
│   │   │   │   ├── globals.css                   # Tailwind theme + premium design tokens (OKLCH, shadows, gradients, glass)
│   │   │   │   ├── not-found.tsx
│   │   │   │   └── icon.svg
│   │   │   └── components/
│   │   │       ├── sidebar.tsx                   # Dashboard sidebar nav (gradient logo, mobile drawer, active state)
│   │   │       └── workspace-switcher.tsx        # Workspace dropdown switcher (rounded-lg, aria attrs)
│   │   ├── src/lib/                                  # Shared utilities
│   │   │   ├── api-client.ts          # Typed API fetch helpers (apiGet/apiPost/apiPatch/apiDelete/apiGetPaginated + ApiError)
│   │   │   ├── api-client.test.ts     # Tests for API helpers (13 tests: success, error, network, parse, pagination)
│   │   │   ├── api-response.ts        # Server-side API helpers (apiSuccess/apiError/apiPaginated/parsePaginationParams)
│   │   │   ├── api-auth.ts            # Auth error response mapper
│   │   │   ├── cache.ts               # React cache() wrappers (getCachedSession/getCachedWorkspaceId/getCachedWorkspaces/getCachedProjects/getCachedDashboardStats/getCachedOnboardingState)
│   │   │   ├── ssrf.ts                # SSRF protection (DNS-resolution-aware URL validation)
│   │   │   ├── ssrf.test.ts           # SSRF tests (35 tests)
│   │   │   ├── rate-limit.ts          # Rate limiting logic (Upstash Redis + in-memory fallback)
│   │   │   ├── rate-limit.test.ts     # Rate limit tests (8 tests)
│   │   │   └── csp.test.ts            # CSP nonce proxy tests (14 tests)
│   │   ├── proxy.ts                       # Next.js proxy: rate limiting + nonce-based CSP (renamed from middleware.ts)
│   │   ├── next.config.ts                        # output: standalone + transpilePackages + serverExternalPackages
│   │   └── package.json
│   └── worker/                                   # Worker service (stub for Sprint 4)
│       └── src/index.ts
├── packages/
│   ├── auth/                                     # Better Auth package
│   │   └── src/
│   │       ├── auth.ts           # betterAuth() config (server-only)
│   │       ├── client.ts         # createAuthClient() (client-safe)
│   │       ├── server.ts         # Server-only re-exports (getSession, requireAuth, etc.)
│   │       ├── session.ts        # Session helpers + workspace access checks
│   │       ├── permissions.ts    # RBAC: role hierarchy + permission matrix
│   │       └── index.ts          # Client-safe exports only (no next/headers)
│   ├── db/                                       # Prisma package
│   │   ├── prisma/
│   │   │   ├── schema.prisma     # Full database schema (669 lines)
│   │   │   ├── seed.ts           # Demo user/workspace/project/policy seed
│   │   │   └── migrations/       # Prisma migrations
│   │   ├── prisma.config.ts      # Prisma 7 config (dotenv + datasource URL)
│   │   └── src/
│   │       ├── client.ts         # PrismaClient with PrismaPg adapter
│   │       ├── scoping.ts        # Workspace scoping + soft-delete model sets (AsyncLocalStorage)
│   │       ├── extension.ts      # Prisma client extension (thin wrapper over scoping.ts)
│   │       ├── extension.test.ts # Scoping + soft-delete regression tests (24 tests)
│   │       ├── audit-hash.ts     # AuditLog hash-chain (computeAuditHash + verifyAuditChain, SHA-256)
│   │       ├── audit-hash.test.ts # Hash-chain tests (21 tests: determinism, chaining, tamper, evidence encryption)
│   │       ├── evidence.ts       # Evidence encryption enforcement (assertEvidenceEncrypted, isValidKeyRefFormat)
│   │       ├── rls.ts            # Postgres RLS helper (withWorkspaceRLS, withoutWorkspaceRLS — SET LOCAL in transaction)
│   │       ├── rls.test.ts       # RLS helper tests (9 tests: context, error propagation, table coverage)
│   │       ├── index.ts          # Re-exports models + prisma client + audit-hash + evidence + RLS utils
│   │       └── generated/prisma/ # Prisma generated client (gitignored)
│   ├── types/                                    # Shared Zod schemas + TS types
│   │   └── src/index.ts          # All schema definitions + ApiResponse types
│   ├── ui/                                       # Shared UI component library (premium design system)
│   │   └── src/
│   │       ├── button.tsx       # Button with cva variants (default/secondary/ghost/destructive/outline × sm/md/lg/icon, transition-[background,box-shadow,transform])
│   │       ├── components.test.ts # Unit tests for buttonVariants, badgeVariants, cn (20 tests)
│   │       ├── card.tsx         # Card, CardHeader, CardTitle, CardContent, CardFooter (rounded-xl, shadow-sm)
│   │       ├── badge.tsx        # Badge with cva variants (default/success/danger/warning/info/muted)
│   │       ├── form-field.tsx   # Input, Textarea, Select, FormField wrapper (rounded-lg, focus ring, transition-[border-color,box-shadow])
│   │       ├── empty-state.tsx  # EmptyState with icon, title, description, action
│   │       ├── spinner.tsx      # Spinner (Loader2 with animate-spin)
│   │       ├── load-more.tsx    # LoadMore pagination button (error handling, aria-busy)
│   │       ├── github-icon.tsx  # GitHub SVG icon (lucide v1 removed brand icons)
│   │       ├── utils.ts         # cn() class merge utility
│   │       └── index.ts         # Re-exports all components
│   ├── config/                                   # Shared tsconfig presets + env validation
│   ├── logger/                                   # Structured JSON logger
│   │   └── src/index.ts
│   └── integrations/                             # External integrations (GitHub App)
│       └── src/
│           ├── github.ts          # JWT, installation tokens, repo listing, webhook verification
│           ├── github.test.ts     # Tests for webhook signature + install URL
│           └── index.ts           # Re-exports
├── docker-compose.yml                            # PostgreSQL 16 + Redis 7 (env-interpolated secrets, Redis password)
├── Dockerfile                                   # Multi-stage build (standalone output, slim runner, ARG-based build secrets)
├── .dockerignore                                # Excludes node_modules, .next, .git, secrets, IDE dirs, docs
├── turbo.json                                    # Turborepo task config
├── pnpm-workspace.yaml                           # Workspace + build allowlist
├── tsconfig.json                                 # Root tsconfig (composite, ES2022)
├── eslint.config.mjs
├── .env / .env.example                           # Environment variables
├── PRD.md                                        # Full PRD + sprint backlog (4000+ lines)
└── package.json                                  # Root scripts (dev, build, db:*)
```

---

## 4. Key Architectural Patterns

### 4.1 Auth Package Split

The auth package has a **client-safe / server-only split** to avoid importing `next/headers` or Prisma into client bundles:

- **`@lyrashield/auth`** (client-safe): `authClient`, `signIn`, `signOut`, `signUp`, `useSession`, `PERMISSIONS`, `hasPermission`, `hasMinimumRole`
- **`@lyrashield/auth/server`** (server-only): `auth`, `getSession`, `requireAuth`, `getWorkspaceMembership`, `requireWorkspaceAccess`, `requirePermission`

**Import rule**: Client components import from `@lyrashield/auth`. Server components and API routes import from `@lyrashield/auth/server`.

### 4.2 Session Interface

`getSession()` returns `AuthSession | null`:
```typescript
interface AuthSession {
  userId: string
  userEmail: string
  userName: string
  userImage: string | null
  sessionId: string
}
```

### 4.3 RBAC System

Defined in `packages/auth/src/permissions.ts`:

**Role hierarchy** (highest to lowest):
`OWNER (100) > ADMIN (80) > SECURITY_ADMIN (75) > APPSEC_MANAGER (70) > BILLING_ADMIN (60) > DEVELOPER (40) > MEMBER (30) > EXTERNAL_PENTESTER (20) > AUDITOR (15) > VIEWER (10)`

**Permission groups**: workspace, member, project, target, scan, finding, fix, report, policy, audit, billing, integration

**Helper functions**:
- `hasPermission(role, permission)` — check if role has specific permission
- `hasMinimumRole(role, minimumRole)` — check if role meets minimum hierarchy
- `isWorkspaceAdmin(role)` — true for ADMIN+
- `isWorkspaceOwner(role)` — true for OWNER only

### 4.4 API Route Pattern

All API routes follow this pattern:
1. Call `getSession()` — return 401 if null
2. Parse and validate body with Zod schema — return 400 on validation error
3. Check permissions via `await requirePermission(workspaceId, permission)` — throws `UNAUTHORIZED` or `FORBIDDEN` on failure
4. Wrap in try/catch — use `authErrorResponse(error)` from `@/lib/api-auth` to map thrown auth errors to 401/403 responses, then fall through to generic 500
5. Perform the operation
6. Write audit log via `prisma.auditLog.create()`
7. Return `{ success: true, data: ... }` or `{ success: false, error: { code, message } }`

**`requirePermission(workspaceId, permission)`** (async, throws):
- Returns `{ session, membership }` on success
- Throws `Error("UNAUTHORIZED")` if no session
- Throws `Error("FORBIDDEN")` if not workspace member or lacks permission
- Callers catch with `authErrorResponse(error)` → returns NextResponse with 401/403

**`authErrorResponse(error)`** (`apps/web/src/lib/api-auth.ts`):
```typescript
// In catch block:
const authErr = authErrorResponse(error)
if (authErr) return authErr  // 401 or 403
// Fall through to generic 500
logger.error("...", { error: String(error) })
return NextResponse.json({ success: false, error: { code: "INTERNAL_ERROR", ... } }, { status: 500 })
```

### 4.5 Server/Client Component Split

- **Server components** (`page.tsx`): Fetch session via `getCachedSession()` (React `cache()`), workspace membership via `getCachedWorkspaceId()`, and data via Prisma with cursor-based pagination (`take: limit + 1` pattern). Pass `initialData` + `initialNextCursor` as props to client components for hydration.
- **Client components** (`*-client.tsx`): Handle form state, use typed API helpers (`apiGet`, `apiPost`, `apiPatch`, `apiGetPaginated` from `@/lib/api-client`) for API calls. Use `LoadMore` component from `@lyrashield/ui` for pagination. Use `useState` + `useEffect` for client-side data fetching when no `initialData`.
- **Dashboard layout** (`(dashboard)/layout.tsx`): Auth guard — redirects to `/sign-in` if no session. Fetches session, onboarding state, and workspace memberships via React `cache()` wrappers from `@/lib/cache`.
- **React `cache()` wrappers** (`@/lib/cache.ts`): `getCachedSession`, `getCachedWorkspaceId`, `getCachedWorkspaces`, `getCachedProjects`, `getCachedDashboardStats` (accepts comma-joined string key for memoization), `getCachedOnboardingState`. These deduplicate Prisma queries within the same request.

### 4.6 Prisma 7 Configuration

- **Config file**: `packages/db/prisma.config.ts` uses `defineConfig()` with dotenv to load `.env` from repo root
- **Schema**: `packages/db/prisma/schema.prisma` — generator outputs to `../src/generated/prisma` (gitignored)
- **Client**: `packages/db/src/client.ts` — singleton with `PrismaPg` adapter, cached on `globalThis` for dev hot reload
- **No datasource URL in schema** — only `provider = "postgresql"`. URL comes from `prisma.config.ts`

### 4.7 SSRF Protection

The SSRF logic lives in a shared helper **`apps/web/src/lib/ssrf.ts`** (`checkScanUrlSafe`), wired into the URL-target path of `apps/web/src/app/api/targets/route.ts`. It does **DNS-resolution-aware** validation, not string-prefix matching:

- Only `http(s)` schemes; rejects empty host and trailing-dot hostnames; blocks `localhost`/`*.localhost`/metadata hostnames.
- **Resolves the hostname and validates every resolved A/AAAA address** against the blocklist (so a public domain that resolves to an internal IP is rejected).
- Full IPv4 CIDR coverage: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16` (link-local + cloud metadata), `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, multicast, reserved. Canonicalizes decimal/octal/hex IPv4.
- IPv6: strips brackets + zone id; handles IPv4-mapped (`::ffff:`), IPv4-compat, NAT64 (`64:ff9b::/96`), ULA (`fc00::/7`), link-local (`fe80::/10`), multicast; fail-closed on unparseable v6.
- Injectable resolver for tests (`ssrf.test.ts`).

**Remaining (deferred to the worker, unbuilt):** this is *create-time* validation. The durable defense against DNS rebinding is *fetch-time* enforcement — resolve→pin IP→connect→re-validate each redirect hop, via an allow-listed egress proxy (PRD PART B §B2.2). Move the helper to `packages/security` when that package lands.

---

## 5. Database Schema Overview

The Prisma schema (`packages/db/prisma/schema.prisma`) defines these models:

### Better Auth Tables (managed by Better Auth, do not manually modify)
- **User** — id, name, email (unique), emailVerified, image
- **Session** — id, expiresAt, token (unique), userId
- **Account** — OAuth/email accounts linked to users
- **Verification** — email verification tokens

### Application Models
- **Workspace** — id, name, slug (unique), mode (VIBE/TEAM/ENTERPRISE), plan (FREE/PRO/TEAM/AGENCY/BUSINESS/ENTERPRISE)
- **WorkspaceMember** — workspaceId, userId, role, status, invitedEmail, invitedById. Unique on `[workspaceId, userId]`
- **Project** — workspaceId, name, description, ownerUserId, riskScore. Has targets, scans, findings
- **Target** — workspaceId, projectId (optional), type (REPO/WEB_APP/API/CLOUD_ACCOUNT/CONTAINER/IAC), name, url, repoProvider/Owner/Name/FullName, branch, environment (LOCAL/PREVIEW/STAGING/PRODUCTION), status, lastScanAt, deletedAt (soft delete)
- **CredentialSet** — encrypted credentials for targets
- **Policy** — workspaceId, scan policy settings (networkEgressPolicy, destructiveTestsAllowed, approvalRequired, maxDurationMinutes, piiRedactionEnabled, evidenceRetentionDays)
- **Scan** — workspaceId, targetId, projectId, goal, mode, status, policyId, startedAt, completedAt, findingsCount
- **ScanEvent** — scanId, type, message, timestamp (streamed scan progress events)
- **Finding** — workspaceId, targetId, scanId, projectId, severity, status, title, description, evidence, cwe, cvss
- **Evidence** — findingId, type, content, redactedContent
- **FixProposal** — findingId, codeDiff, description, status
- **PullRequest** — fixProposalId, url, status
- **Ticket** — findingId, url, provider
- **Integration** — workspaceId, type (GITHUB/SLACK/JIRA/etc), name, configRef, status, capabilities (JSON), externalId (GitHub installation ID), metadata (JSON: accountLogin, accountId, accountType, setupAction), deletedAt. Unique on `[workspaceId, type, externalId]`
- **WebhookEvent** — workspaceId (nullable), provider, eventType, externalId, payload (JSON), processed, processedAt, error. Unique on `[provider, externalId]`
- **OnboardingState** — userId (unique), currentStep (0-6), completed, skipped, workspaceId, targetId, selectedGoal, createdAt, updatedAt
- **UsageRecord** — workspaceId, kind, quantity, idempotencyKey (unique), metadata (JSON), deletedAt
- **AuditLog** — workspaceId, actorUserId, action, resourceType, resourceId, metadata (JSON)
- **Invitation** — workspaceId, email, token (unique), role, status (pending/accepted/expired), expiresAt, invitedById

---

## 6. Environment Variables

Required for local development (see `.env.example`):

```bash
# Database
DATABASE_URL="postgresql://lyrashield:lyrashield@localhost:5432/lyrashield?schema=public"

# Redis (redis:// — reserved for the BullMQ job queue, Sprint 4+)
REDIS_URL="redis://localhost:6379"

# Upstash Redis REST — distributed rate limiting in production (HTTP endpoint +
# token; NOT the redis:// URL above). If the URL is set, the token is required.
UPSTASH_REDIS_REST_URL=""
UPSTASH_REDIS_REST_TOKEN=""

# Better Auth
BETTER_AUTH_SECRET="replace-with-a-strong-secret-key-min-32-chars"
BETTER_AUTH_URL="http://localhost:3000"
# Comma-separated extra origins trusted for auth/CSRF (staging, apex+www, preview).
# BETTER_AUTH_URL is always trusted; these are appended.
ADDITIONAL_TRUSTED_ORIGINS=""

# GitHub OAuth (sign-in)
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""

# GitHub App (integration — Sprint 3)
GITHUB_APP_ID=""
GITHUB_APP_SLUG=""          # slug from github.com/apps/<slug> — used to build the install URL (NOT the numeric id)
GITHUB_APP_PRIVATE_KEY=""
GITHUB_WEBHOOK_SECRET=""

# Google OAuth (optional)
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""

# App
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

Additional env vars for later sprints: S3/R2 evidence storage, Brevo email, Polar/Razorpay billing, Sentry monitoring, LyraShield engine (`LYRASHIELD_LLM`, `LLM_API_KEY`, `LYRASHIELD_IMAGE`, `LYRASHIELD_ENGINE_PATH`, `LYRASHIELD_TELEMETRY=false`).

---

## 7. Development Commands

```bash
# Start dev server (web + worker)
pnpm dev

# Build all packages
pnpm build

# Lint / typecheck
pnpm lint
pnpm typecheck

# Test
pnpm test                # Run all tests (vitest)
pnpm test:watch          # Watch mode

# Format
pnpm format
pnpm format:check

# Database
pnpm db:generate          # Generate Prisma client
pnpm db:migrate           # Run migrations
pnpm db:push              # Push schema without migration
pnpm db:seed              # Seed demo data
pnpm db:studio            # Open Prisma Studio

# Docker (Postgres + Redis)
docker compose up -d      # Start services
docker compose down       # Stop services
```

**First-time setup**:
1. `docker compose up -d` — start Postgres + Redis
2. `pnpm install` — install dependencies
3. `pnpm db:generate` — generate Prisma client
4. `pnpm db:migrate` — run migrations
5. `pnpm db:seed` — seed demo data
6. `pnpm dev` — start dev server at http://localhost:3000

---

## 8. Sprint Progress

### Sprint 0: Repo and Foundation — ✅ Complete
- Turborepo + pnpm workspaces
- All packages created (db, auth, ui, types, integrations, config, logger)
- Docker Compose for Postgres + Redis
- ESLint, Prettier, TypeScript config
- CI setup

### Sprint 1: Prisma Schema and Better Auth — ✅ Complete
- Better Auth with email/password + GitHub OAuth + Google OAuth (optional)
- Full Prisma schema with all models
- Session management (7-day expiry, 1-day refresh)
- Auth middleware in dashboard layout
- Workspace creation flow (creates workspace + owner membership + default policy + audit log in transaction)
- Team invite flow (Invitation model with 7-day expiry)
- Account deletion endpoint
- Seed script with demo user/workspace/project/policy

### Sprint 2: Dashboard, Projects, Targets — ✅ Complete
- Dashboard layout with sidebar navigation
- Workspace switcher dropdown (with Escape key, aria attrs)
- Project list page with create form
- Target list page with repo + URL target creation forms
- Target detail page with recent scans
- Team members page with invite form
- SSRF validation for URL targets
- Audit logs for all create operations
- Empty states for all list pages
- Loading states for all pages

**Code review and hardening (post-implementation)**:
- SSRF blocklist hardened: full 127.0.0.0/8, IPv6-mapped IPv4 (::ffff:), fd00::/8, trailing-dot bypass prevention
- Team invite duplicate check: queries both WorkspaceMember and pending Invitation records
- Error states with retry UI on all client components
- Accessibility: htmlFor/id label associations, autoFocus on first form field, Escape key on dropdowns, aria-expanded/aria-haspopup/role=listbox on workspace switcher, aria-label on sign-out
- Stale error clearing on form cancel
- Redirect instead of notFound for authorization failures (prevents info leakage)
- Removed unused imports (Trash2, Plus)
- Radar icon for Scans nav item (was duplicate Crosshair)
- Empty description sent as undefined instead of empty string

### Sprint 2.5: Onboarding Flow — ✅ Complete
- **OnboardingState model**: `OnboardingState` in Prisma schema — tracks `currentStep`, `completed`, `skipped`, `workspaceId`, `targetId`, `selectedGoal` per user
- **Onboarding API**: `GET/PATCH /api/onboarding` — auto-creates state on first GET, upsert on PATCH, Zod-validated via `UpdateOnboardingSchema`
- **Onboarding wizard**: `/onboarding` page with 7-step guided flow (Workspace → Target → Goal → Preflight → Scan → Results → Fix)
- **Progress indicator**: Visual step tracker with checkmarks for completed steps
- **Skip option**: Users can skip onboarding at any step; sets `skipped: true` and redirects to dashboard
- **Completion tracking**: `completed: true` on finish; dashboard layout redirects incomplete/non-skipped users to `/onboarding`
- **Sign-up redirect**: Both email and GitHub sign-up now redirect to `/onboarding` instead of `/dashboard`
- **Steps 4-6 (Scan/Results/Fix)**: Placeholder UI with clear messaging that engine integration comes in Sprint 5
- **Zod schemas**: `OnboardingStepSchema`, `UpdateOnboardingSchema` added to `@lyrashield/types`

### Pre-Sprint-3 Hardening (PRD §B1.4 + §B4) — ✅ Complete
- **Env validation**: Zod schema in `@lyrashield/config` — fails fast on missing/invalid `BETTER_AUTH_SECRET`, `DATABASE_URL`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`
- **Email verification**: `requireEmailVerification: true` in `auth.ts`; Brevo integration for production, console.log in dev; `sendOnSignUp: true`
- **Rate limiting**: `proxy.ts` (renamed from `middleware.ts` per Next.js 16) — auth endpoints 5/min per IP, general API 30/min per IP; Upstash Redis in prod, in-memory fallback in dev
- **Schema retrofits (§B4)**:
  - Finding dedupe key: `@@unique([targetId, dedupeKey])` (was `[workspaceId, dedupeKey]`)
  - ApiKey model: hashedKey, prefix, scopes, expiresAt, revokedAt, lastUsedAt
  - Evidence.encryptionKeyRef added
  - AuditLog.prevHash added (hash-chain ready)
  - Soft-delete (`deletedAt`) standardized across all models
  - Duplicate-target guards: `@@unique([workspaceId, repoFullName])` + `@@unique([workspaceId, url])`
  - Report.shareToken → shareTokenHash (hashed at rest) + revokedAt
  - UsageRecord.idempotencyKey added
  - Composite indexes: `Finding(workspaceId, status, severity)`, `AuditLog(workspaceId, createdAt)`
  - Redundant `@@index([slug])` on Workspace removed (already @unique)
  - Retest model added (P2)
- **Prisma Client Extension**: auto-injects `deletedAt: null` on reads, `workspaceId` scoping, redirects `delete` → soft-delete
- **License hygiene**: `engine-NOTICE.md` and `engine-CHANGES.md` templates created for Apache-2.0 §4b compliance

### Sprint 3: GitHub App Integration — ✅ Complete
- **Integration module** (`@lyrashield/integrations`): GitHub App JWT minting (RS256), installation token fetching, repo listing, webhook signature verification (HMAC-SHA256 with timing-safe comparison)
- **Schema updates**: `Integration` model — added `externalId` (installation ID), `metadata` (JSON for account info), `@@unique([workspaceId, type, externalId])`
- **Installation callback**: `GET /api/integrations/github/install` — receives GitHub OAuth redirect, stores installation metadata, creates audit log
- **Install URL generation**: `POST /api/integrations/github/install` — returns GitHub App install URL with workspace state
- **Repo listing**: `GET /api/integrations/github/repos` — lists accessible repos via installation token
- **Webhook handler**: `POST /api/webhooks/github` — verifies signature, handles `installation.deleted` (disables targets, soft-deletes integration) and `pull_request` events (stores in WebhookEvent)
- **Integrations UI**: `/dashboard/integrations` page with GitHub connect button, repo picker, and target creation from selected repo
- **Sidebar**: Added Integrations nav item with Plug icon
- **Security**: GitHub secrets stored only as installation metadata (configRef pattern), no raw tokens in DB; webhook signature verification required
- **Tests**: `packages/integrations/src/github.test.ts` (9 tests: webhook signature valid/invalid/null/empty/wrong-secret/tampered/wrong-length, install URL format), `packages/types/src/index.test.ts` (21 tests: OnboardingStepSchema + UpdateOnboardingSchema validation). Total: 133 tests passing (113 original + 20 UI component tests added in Batch 2).

### Sprint 4: Scan Orchestrator and Queue — ✅ Complete
- BullMQ scan queue with Redis
- Preflight checks (URL reachability, DNS, SSRF validation)
- Engine runner (child process subprocess invocation)
- Output parser (structured JSON findings)
- Finding persister (encrypted evidence storage)
- Scan lifecycle state machine (QUEUED → PREFLIGHT → RUNNING → COMPLETED/FAILED/CANCELLED)
- Scan API routes (POST create, GET list, GET by ID, POST cancel)
- Scan detail UI with client-side polling
- See §21 for full details

### Sprint 5: Engine MVP — ✅ Complete
- External `lyrashield-engine` binary wired via `runner.ts` + `command-builder.ts`
- See §21 for full details

### Sprint 6: Findings Normalization — ✅ Complete
- `normalizer.ts` with severity normalization, CWE enrichment (40+ mappings), CVSS v3.1 estimation, confidence scoring, false-positive risk assessment, cross-source deduplication, finding statistics
- 14 tests. See §23 for full details

### Sprint 6.5: SCA + Secrets Scanning — ✅ Complete
- `sca-scanner.ts` (7 dep file formats, OSV API), `secrets-scanner.ts` (12 secret patterns), `scanner-orchestrator.ts` (parallel scan, normalize, merge)
- 24 new tests. See §23 for full details

### Sprint 7: Tier 2 — ✅ Complete
- AI-builder-aware URL scanner (10 detectors), launch-readiness UI, shareable report/badge, MCP server with real API calls + stdio transport, prompt-injection defense (27 patterns), GitHub Action diff-gate
- 16 new tests. See §24 for full details

### UI/UX Refinement Sweep — ✅ Complete
- Raw `<label>` → `FormField` component, raw color classes → design tokens, `aria-hidden` on all decorative icons, `tracking-tight` on all headings, `Spinner` in all loading states
- See §25 for full details

### Docker Deployment — ✅ Verified
- All 5 containers build and run, 18 pages return correct HTTP codes (200/307/404), 13 API endpoints respond correctly, 7 migrations applied, 18 RLS tables confirmed, 781 tests pass inside container

### UI/UX Premium Upgrade (2026-07-05) — ✅ Complete

A full visual audit and upgrade of the entire app UI for a modern, premium look with richer colors, shadows, gradients, glassmorphism, and larger radii. All pages are fully responsive and mobile-optimized.

**Design system (`globals.css`)**:
- OKLCH color space for all tokens (light + dark mode)
- Custom shadow scale: `--shadow-xs` through `--shadow-lg`, `--shadow-primary`
- Enlarged radii: `--radius-sm` (0.375rem) through `--radius-2xl` (1.25rem)
- Premium utility classes: `.glass` (glassmorphism), `.gradient-primary`, `.gradient-hero`, `.text-gradient`, `.shadow-premium`, `.shadow-card-hover`, `.shadow-primary-glow` — all with dark mode variants
- Antialiased font rendering (`-webkit-font-smoothing: antialiased`)

**Shared UI components (`packages/ui`)**:
- `Button`: cva-based variants (default with `gradient-primary` + `shadow-sm` + `hover:shadow-primary-glow`, secondary, ghost, destructive, outline) × sizes (sm, md, lg, icon). `active:scale-[0.98]` press feedback.
- `Card`: `rounded-xl`, `shadow-sm`, `transition-shadow` on hover
- `Badge`: cva variants — default, success (emerald), danger (destructive), warning (amber), info (sky), muted
- `Input`/`Textarea`/`Select`: `rounded-lg`, `shadow-xs`, `focus:ring-2 focus:ring-ring focus:border-primary/50`, `transition-all`
- `EmptyState`: `rounded-xl border-dashed`, primary-tinted icon background (`bg-primary/5`), `aria-hidden` on icon
- `Spinner`: `Loader2` with `animate-spin`, `aria-hidden`

**Landing page**: Gradient hero background, glassmorphic floating navbar (`.glass` + `backdrop-blur`), gradient CTA buttons, feature cards with hover-lift (`hover:-translate-y-1 hover:shadow-lg`), `aria-label` on nav

**Auth pages (sign-in/sign-up)**: Gradient background (`.gradient-hero`), premium card with `shadow-primary-glow` logo badge, gradient CTA buttons, `setLoading(false)` in `finally` block for GitHub OAuth error handling

**Sidebar**: Gradient logo badge (`.gradient-primary`), mobile drawer with overlay backdrop, active route with `bg-primary/8 text-primary`, user avatar with initial, `aria-label` on close button, open-menu button hidden when sidebar is open

**Dashboard**: Gradient stat cards with icon backgrounds (`bg-primary/5 group-hover:bg-primary/10`), hover shadow, premium workspace cards with role badges, `title` attribute on New Scan button

**Targets page**: Mobile-responsive table (`hidden sm:table-cell` on non-essential columns), `overflow-x-auto`, clickable rows with `role="link"` + `aria-label`, premium form card with `rounded-xl shadow-sm`

**Projects page**: Responsive header (`flex-col sm:flex-row`), hover-lift project cards (`hover:-translate-y-0.5 hover:shadow-md`), risk badges

**Team page**: Responsive table with hidden columns on mobile, OWNER badge distinguished from ADMIN (default vs info variant), premium invite form card

**Target detail**: Responsive header with `flex-wrap`, hover-lift stat cards, premium table with hidden date column on mobile, card sections with `shadow-sm`

**Integrations page**: Card with `shadow-sm`, responsive flex layout (`flex-col sm:flex-row`), repo list buttons with `rounded-lg`

**Onboarding wizard**: Gradient step indicators (completed = `.gradient-primary`, current = `border-primary shadow-primary-glow`), step labels hidden on mobile (`hidden sm:block`), all action buttons use `gradient-primary rounded-lg`, `PreflightItem` with `rounded-lg` + gradient checkmark + `Clock` icon for pending items, `grid-cols-2` for mode selector buttons

**Onboarding page**: Gradient hero background, gradient logo badge with `shadow-primary-glow`, `aria-hidden` on icon

**Workspace switcher**: `rounded-lg` items, `transition-colors` on hover

**Deep code review fixes (2026-07-05)**:
- Dark mode variants added for `.gradient-primary`, `.text-gradient`, `.shadow-card-hover` (were invisible/too dark in dark mode)
- Dead `--shadow-card-hover` CSS vars removed from theme blocks; moved to proper utility class
- Sidebar: open-menu button hidden when sidebar is open (was both visible simultaneously)
- Auth pages: `setLoading(false)` moved to `finally` block (button stayed disabled on OAuth redirect failure)
- Onboarding wizard: mode selector changed from `flex` to `grid-cols-2` (overflow on narrow screens), all buttons upgraded to `gradient-primary rounded-lg`, `PreflightItem` icon changed from `Plus` to `Clock` (was confusing)
- Team page: OWNER badge distinguished from ADMIN (`default` vs `info` variant)
- Targets table: `role="link"` + `aria-label` added to clickable rows for screen readers
- Dashboard: `title` attribute on New Scan button (links to placeholder page)
- GitHub integration: repo buttons upgraded from `rounded-md` to `rounded-lg`
- Landing page: `aria-label="Main navigation"` on nav, `container` replaced with `max-w-5xl mx-auto` in footer
- Onboarding page: `aria-hidden="true"` on ShieldCheck icon

**Verification**: lint ✅ (0 errors), typecheck ✅, tests ✅ (727/727, 56 files), build ✅

### Engine Repo (lyrashield-engine) — Forked & Rebranded

The engine repo has been forked from usestrix/strix, fully rebranded to LyraShield, and is ready for upgrades. See [Engine Repo Status](#engine-repo-status) in Section 1 for full details.

**Completed**:
- Fork from usestrix/strix with upstream remote configured
- Full rebrand: zero "Strix" references remaining, CLI binary renamed to `lyrashield`
- Telemetry disabled (PostHog + Scarf off by default, `LYRASHIELD_TELEMETRY=false`)
- Upgrade roadmap documented in `UPGRADES.md`

**Pending** (mapped to sprints):
- Sprint 5: ✅ Done — Structured JSON findings, exit codes, event streaming, policy hooks
- Sprint 6: ✅ Done — Dedupe keys, evidence packaging, CVSS auto-scoring
- Sprint 7: ✅ Done — Structured patch output with safety score
- Post-Sprint 7: Webhooks, parallel orchestration, custom skills, sandbox hardening

---

## 9. API Reference

### Authentication
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/[...all]` | Better Auth handler (sign-in, sign-up, sign-out, OAuth callbacks) |

### Onboarding
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/onboarding` | Get current user's onboarding state (auto-creates if missing) | Authenticated |
| PATCH | `/api/onboarding` | Update onboarding state (step, completed, skipped, workspaceId, targetId, selectedGoal) | Authenticated |

### Workspaces
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/workspaces` | Create workspace (creates owner membership + default policy + audit log) | Authenticated |
| GET | `/api/workspaces` | List user's workspaces | Authenticated |

### Projects
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/projects` | Create project | Active workspace member |
| GET | `/api/projects?workspaceId=<id>` | List projects with target/scan/finding counts | Active workspace member |

### Targets
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/targets` | Create repo or URL target (SSRF validation on URL targets) | Active workspace member |
| GET | `/api/targets?workspaceId=<id>&projectId=<optional>` | List targets with project name, scan/finding counts | Active workspace member |

### Team
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/team` | Invite team member (creates Invitation with 7-day expiry) | OWNER or ADMIN |
| GET | `/api/team?workspaceId=<id>` | List active members + pending invitations | Active workspace member |

### Integrations — GitHub App
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/integrations/github/install` | GitHub OAuth callback — stores installation metadata, redirects to dashboard | Authenticated + `integration.manage` |
| POST | `/api/integrations/github/install` | Returns GitHub App install URL with workspace state | Authenticated + `integration.manage` |
| GET | `/api/integrations/github/repos?workspaceId=<id>` | List accessible repos via installation token | Authenticated + `integration.manage` |

### Webhooks
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/webhooks/github` | GitHub webhook handler — verifies HMAC-SHA256 signature, handles `installation.deleted` + `pull_request` | Webhook signature (no session) |

**API response format**:
```json
// Success
{ "success": true, "data": ... }

// Error
{ "success": false, "error": { "code": "ERROR_CODE", "message": "Human-readable message" } }
```

**Common error codes**: `UNAUTHORIZED` (401), `FORBIDDEN` (403), `VALIDATION_ERROR` (400), `INVALID_JSON` (400), `MISSING_PARAM` (400), `SSRF_BLOCKED` (400), `ALREADY_INVITED` (409), `SLUG_TAKEN` (409), `PROJECT_NOT_FOUND` (404), `NOT_CONNECTED` (404), `NOT_FOUND` (404), `INVALID_SIGNATURE` (401), `MISSING_HEADERS` (400), `CONFIG_ERROR` (500), `INTERNAL_ERROR` (500)

---

## 10. UI Components

### Shared Component Library (`packages/ui`)

All components use `forwardRef` and `cn()` (clsx + tailwind-merge) for class merging. Variants are managed via `class-variance-authority` (cva).

**Button** (`button.tsx`):
- Variants: `default` (gradient-primary + shadow + hover glow), `secondary` (border + bg-card), `ghost`, `destructive`, `outline`
- Sizes: `sm` (h-8), `md` (h-10), `lg` (h-11), `icon` (h-10 w-10)
- Press feedback: `active:scale-[0.98]`
- Transition: `transition-[background,box-shadow,transform]` (specific properties, not `transition-all`)
- Focus: `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`
- Exported: `Button`, `buttonVariants`, `ButtonProps`

**Card** (`card.tsx`): `Card` (rounded-xl, shadow-sm, transition-shadow), `CardHeader`, `CardTitle`, `CardContent`, `CardFooter`

**Badge** (`badge.tsx`):
- Variants: `default` (bg-secondary), `success` (emerald), `danger` (destructive), `warning` (amber), `info` (sky), `muted`
- Rounded-full, gap-1 for icon + text
- Exported: `Badge`, `badgeVariants`, `BadgeProps`

**Input/Textarea/Select** (`form-field.tsx`): `rounded-lg`, `shadow-xs`, `focus:ring-2 focus:ring-ring focus:border-primary/50`, `transition-[border-color,box-shadow]`, `placeholder:text-muted-foreground/60`

**FormField** (`form-field.tsx`): Wrapper with `<label htmlFor>` + children. Props: `label`, `htmlFor`, `children`, `className`

**EmptyState** (`empty-state.tsx`): `rounded-xl border-dashed bg-card/50`, icon in `rounded-xl bg-primary/5`, title, description, action slot. Props: `icon`, `title`, `description`, `action`, `className`

**Spinner** (`spinner.tsx`): `Loader2` with `animate-spin`, `aria-hidden="true"`. Props: `className`

**GithubIcon** (`github-icon.tsx`): Custom GitHub SVG icon (lucide v1 removed brand icons). Accepts `className` prop.

### Sidebar (`apps/web/src/components/sidebar.tsx`)
- Navigation with icons: Dashboard, Projects, Targets, Scans (Radar icon), Findings, Fixes, Reports, Team, Integrations (Plug icon), Settings
- Gradient logo badge (`.gradient-primary`) at top
- Workspace switcher embedded at top
- Active route highlighting via `usePathname` with `bg-primary/8 text-primary font-semibold`
- User avatar with initial in `rounded-full bg-primary/10` + name/email
- Sign-out calls `signOut()` from `@lyrashield/auth`
- Mobile: fixed drawer (`w-64`) with overlay backdrop, `translate-x` transition, open button hidden when sidebar is open
- `aria-label` on open/close buttons, `aria-current="page"` on active nav item, `aria-hidden` on all icons

### Onboarding Wizard (`apps/web/src/app/onboarding/onboarding-wizard.tsx`)
- 7-step guided flow: Workspace → Target → Goal → Preflight → Scan → Results → Fix
- Gradient step indicators (completed = `.gradient-primary`, current = `border-primary shadow-primary-glow`)
- Current step label always visible on mobile (`block`); non-current steps hidden on mobile (`hidden sm:block`)
- All action buttons use shared `Button` component from `@lyrashield/ui` (default variant for primary actions, ghost variant for Back/Skip)
- All inputs use shared `Input` component from `@lyrashield/ui`
- Loading states use shared `Spinner` component (replaces inline `Loader2 animate-spin`)
- `PreflightItem` with `rounded-lg` + gradient checkmark + `Clock` icon for pending items, `aria-hidden` on icons
- Mode selector uses `grid-cols-2` for equal-width buttons, `transition-[border-color,box-shadow]`
- Error banner uses `role="alert"` for accessibility
- Skip option at every step (sets `skipped: true`, redirects to `/dashboard`)
- Fetches and updates state via `GET/PATCH /api/onboarding`
- Steps 4-6 (Scan/Results/Fix) show placeholder UI with `rounded-xl border-dashed bg-card/50` (engine integration in Sprint 5)
- Completion sets `completed: true` and redirects to `/dashboard`

### GitHub Integration (`apps/web/src/app/(dashboard)/dashboard/integrations/github-integration.tsx`)
- Connect button: calls `POST /api/integrations/github/install` → redirects to GitHub App install page
- Repo picker: calls `GET /api/integrations/github/repos` → displays selectable list with private badges, `rounded-lg` buttons
- Target creation: calls `POST /api/targets` with selected repo data (type: REPO, provider: github)
- Connected state: shows account login badge with checkmark
- Error handling: inline error banners for all operations
- Uses `Spinner` from `@lyrashield/ui` for loading states

### Workspace Switcher (`apps/web/src/components/workspace-switcher.tsx`)
- Dropdown with click-outside and Escape key to close
- ARIA attributes: `aria-expanded`, `aria-haspopup`, `role="listbox"`, `role="option"`, `aria-selected`
- `rounded-lg` items with `transition-colors` on hover
- Calls `onSelect(workspaceId)` — parent handles workspace switching

### Client Components Pattern
All client components (`*-client.tsx`) follow this pattern:
- `useState` for form fields, loading, error, fetchError
- `useEffect` to fetch data on mount
- Loading state: centered "Loading..." text
- Error state: error message + retry button
- Empty state: dashed border card with icon and CTA
- Form: error banner, labeled inputs (htmlFor/id), autoFocus on first field, clear error on cancel

---

## 11. Shared Types (`packages/types/src/index.ts`)

All Zod schemas and TypeScript types are defined here:

**Enum schemas**: WorkspaceMode, WorkspacePlan, MemberRole, TargetType, TargetEnvironment, ScanGoal, ScanMode, ScanStatus, FindingSeverity, FindingStatus, IntegrationType

**Input schemas**:
- `CreateWorkspaceSchema` — name (1-100), mode (default VIBE)
- `CreateProjectSchema` — workspaceId, name (1-100), description (optional, max 500)
- `CreateRepoTargetSchema` — workspaceId, projectId (optional), type: REPO, name, repoProvider (default github), repoOwner, repoName, branch (optional), environment (default STAGING)
- `CreateUrlTargetSchema` — workspaceId, projectId (optional), type: WEB_APP|API, name, url (z.url()), environment (default STAGING)
- `CreateScanSchema` — workspaceId, targetId, goal, mode (default SAFE), policyId (optional)
- `OnboardingStepSchema` — enum: WORKSPACE, TARGET, GOAL, PREFLIGHT, SCAN, RESULTS, FIX
- `UpdateOnboardingSchema` — currentStep (0-6, optional), completed (bool, optional), skipped (bool, optional), workspaceId (string|null, optional), targetId (string|null, optional), selectedGoal (ScanGoal|null, optional)

**Response types**: `ApiResponse<T>`, `PaginatedResponse<T>`

---

## 12. Logger (`packages/logger/src/index.ts`)

Structured JSON logger with level filtering:
```typescript
logger.info("Project created", { projectId: "abc", workspaceId: "xyz" })
// Output: {"level":"info","message":"Project created","timestamp":"2026-07-01T...","projectId":"abc","workspaceId":"xyz"}
```

- Levels: debug, info, warn, error
- `LOG_LEVEL` env var controls minimum level (default: info)
- `createLogger(scope)` returns scoped logger

---

## 13. Next.js Configuration

`apps/web/next.config.ts`:
- `transpilePackages`: All `@lyrashield/*` packages
- `serverExternalPackages`: `@prisma/client`, `@prisma/adapter-pg`, `@prisma/client-runtime-utils`

**Proxy** (`apps/web/src/proxy.ts`) — Rate limiting + nonce-based CSP on every request:
- Auth endpoints (`/api/auth/*`): 5 requests/min per IP
- General API (`/api/*`): 30 requests/min per IP
- Uses Upstash Redis in production, in-memory Map fallback in dev
- Auth protection is handled in the `(dashboard)/layout.tsx` server component via `getSession()` + `redirect()`
- Onboarding redirect: layout checks `OnboardingState` — redirects incomplete/non-skipped users to `/onboarding`

---

## 14. Coding Conventions

- **Imports**: Use `@lyrashield/*` workspace package imports, not relative paths across packages
- **Server vs client**: `"use client"` directive at top of client components. Server components have no directive
- **API routes**: Always validate input with Zod, check auth + workspace membership, write audit logs
- **Error handling**: API routes return `{ success: false, error: { code, message } }` with appropriate HTTP status
- **Database queries**: Always scope by `workspaceId` to prevent cross-tenant data access
- **Soft deletes**: Targets use `deletedAt` field (filter with `deletedAt: null`)
- **Icons**: Use `lucide-react` icons. Each nav item should have a unique icon. Brand icons (e.g. GitHub) are not in lucide v1 — use `GithubIcon` from `@lyrashield/ui`. All decorative icons must have `aria-hidden="true"`
- **UI components**: Use shared components from `@lyrashield/ui` (Button, Card, Badge, Input, Textarea, Select, FormField, EmptyState, Spinner, GithubIcon). Use `buttonVariants`/`badgeVariants` for consistent variant styling. All components use `forwardRef` and `cn()` for class merging
- **Premium design tokens**: Use OKLCH colors, custom shadows, and utility classes from `globals.css` (`.glass`, `.gradient-primary`, `.gradient-hero`, `.text-gradient`, `.shadow-premium`, `.shadow-card-hover`, `.shadow-primary-glow`). All have dark mode variants. Use `rounded-lg` or `rounded-xl` for cards/buttons, not `rounded-md`
- **Responsive**: Mobile-first. Use `flex-col sm:flex-row` for headers, `hidden sm:table-cell` for non-essential table columns, `overflow-x-auto` for tables, `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` for card grids
- **Forms**: Labels must have `htmlFor`/`id` associations. First field should have `autoFocus`. Cancel button should clear errors
- **Error states**: Client components should show error message + retry button on fetch failure
- **Accessibility**: Add `aria-*` attributes to interactive elements (dropdowns, buttons with icons)
- **Audit logs**: Write to `prisma.auditLog` for all sensitive operations (create, update, delete, invite)

---

## 15. Important Gotchas

1. **Prisma generated client is gitignored** — Run `pnpm db:generate` after clone or after pulling schema changes
2. **Prisma 7 requires driver adapter** — `PrismaPg` is used in `client.ts`, not a direct `DATABASE_URL` connection
3. **Auth package import paths matter** — `@lyrashield/auth` for client, `@lyrashield/auth/server` for server. Mixing these up causes build errors
4. **No tailwind.config.js** — TailwindCSS 4 uses CSS-first config in `globals.css` with `@theme` directive
5. **Seed script needs env file** — Run `pnpm db:seed` (not `tsx prisma/seed.ts` directly) because the script flag `--env-file=../../.env` is in package.json
6. **Turbopack caching** — If you see stale builds, clear `.next/` and `.turbo/` directories
7. **Port conflicts** — If port 3000 is in use, Next.js auto-switches to 3001. Kill the old process first
8. **`notFound()` vs `redirect()`** — Use `notFound()` only when the resource truly doesn't exist. Use `redirect("/dashboard")` for authorization failures to prevent info leakage
9. **Zod 4 breaking changes** — Use `z.url()` and `z.email()` instead of `z.string().url()` and `z.string().email()`
10. **TypeScript 6** — `types: ["node"]` is required in tsconfig. `baseUrl` is deprecated, use `paths` in each package's tsconfig
11. **lucide-react v1.x** — Brand icons (`Github`, `Twitter`, etc.) were removed. Use `GithubIcon` from `@lyrashield/ui` for GitHub icon
12. **Test files excluded from typecheck** — `*.test.ts` files are excluded from `tsc --noEmit` via tsconfig `exclude` patterns. Tests are run separately via `vitest`
13. **`*.tsbuildinfo` gitignored** — TypeScript incremental build info files are not tracked in git

---

## 16. File Quick Reference

| File | Purpose |
|------|---------|
| `apps/web/src/app/(dashboard)/layout.tsx` | Auth guard + onboarding redirect + sidebar shell |
| `apps/web/src/app/(dashboard)/dashboard/page.tsx` | Main dashboard with aggregate stats |
| `apps/web/src/app/(dashboard)/dashboard/projects/projects-client.tsx` | Project list + create form |
| `apps/web/src/app/(dashboard)/dashboard/targets/targets-client.tsx` | Target list + repo/URL create forms |
| `apps/web/src/app/(dashboard)/dashboard/targets/[id]/page.tsx` | Target detail with scans |
| `apps/web/src/app/(dashboard)/dashboard/integrations/page.tsx` | Integrations page (server component) |
| `apps/web/src/app/(dashboard)/dashboard/integrations/github-integration.tsx` | GitHub connect + repo picker + target creation |
| `apps/web/src/app/(dashboard)/dashboard/team/team-client.tsx` | Team members + invite form |
| `apps/web/src/app/onboarding/page.tsx` | Onboarding wizard server component (auth guard) |
| `apps/web/src/app/onboarding/onboarding-wizard.tsx` | 7-step onboarding wizard (client component) |
| `apps/web/src/app/api/onboarding/route.ts` | GET + PATCH onboarding state API |
| `apps/web/src/app/api/projects/route.ts` | POST + GET projects API |
| `apps/web/src/app/api/targets/route.ts` | POST + GET targets API (with SSRF) |
| `apps/web/src/app/api/team/route.ts` | POST invite + GET members API |
| `apps/web/src/app/api/workspaces/route.ts` | POST create + GET list workspaces API |
| `apps/web/src/app/api/integrations/github/install/route.ts` | GET callback + POST install URL for GitHub App |
| `apps/web/src/app/api/integrations/github/repos/route.ts` | GET list installation repos |
| `apps/web/src/app/api/webhooks/github/route.ts` | POST GitHub webhook handler (signature verification) |
| `apps/web/src/lib/api-auth.ts` | authErrorResponse helper for API routes |
| `apps/web/src/proxy.ts` | Rate limiting + nonce-based CSP proxy (auth 5/min, API 30/min, per-request nonce) |
| `apps/web/src/components/sidebar.tsx` | Dashboard sidebar navigation (with Integrations) |
| `apps/web/src/components/workspace-switcher.tsx` | Workspace dropdown switcher |
| `packages/auth/src/auth.ts` | Better Auth config |
| `packages/auth/src/session.ts` | Session + workspace access helpers (requirePermission) |
| `packages/auth/src/permissions.ts` | RBAC role/permission matrix |
| `packages/auth/src/client.ts` | Better Auth client (client-safe) |
| `packages/auth/src/index.ts` | Client-safe exports |
| `packages/auth/src/server.ts` | Server-only exports |
| `packages/db/prisma/schema.prisma` | Full database schema |
| `packages/db/prisma.config.ts` | Prisma 7 config |
| `packages/db/src/client.ts` | PrismaClient singleton with PrismaPg |
| `packages/db/src/index.ts` | DB package exports |
| `packages/integrations/src/github.ts` | GitHub App: JWT, tokens, repo listing, webhook verification |
| `packages/integrations/src/github.test.ts` | Tests for webhook signature + install URL |
| `packages/integrations/src/index.ts` | Integrations package re-exports |
| `packages/types/src/index.ts` | All Zod schemas + TS types |
| `packages/types/src/index.test.ts` | Tests for OnboardingStep + UpdateOnboarding schemas |
| `packages/ui/src/button.tsx` | Button component with cva variants (default/secondary/ghost/destructive/outline × sm/md/lg/icon) |
| `packages/ui/src/card.tsx` | Card, CardHeader, CardTitle, CardContent, CardFooter components |
| `packages/ui/src/badge.tsx` | Badge component with cva variants (default/success/danger/warning/info/muted) |
| `packages/ui/src/form-field.tsx` | Input, Textarea, Select, FormField wrapper components |
| `packages/ui/src/empty-state.tsx` | EmptyState component (icon, title, description, action) |
| `packages/ui/src/spinner.tsx` | Spinner component (Loader2 with animate-spin) |
| `packages/ui/src/github-icon.tsx` | GitHub SVG icon (lucide v1 removed brand icons) |
| `packages/ui/src/utils.ts` | cn() class merge utility (clsx + tailwind-merge) |
| `packages/ui/src/index.ts` | UI package exports (cn, GithubIcon, Button, Card, Badge, EmptyState, Spinner, FormField, Input, Select, Textarea) |
| `packages/config/src/env.ts` | Zod env validation schema (fails fast on boot) |
| `packages/config/src/env.test.ts` | Tests for env validation |
| `packages/config/src/index.ts` | Config package exports |
| `packages/db/src/extension.ts` | Prisma client extension (soft-delete, workspace scoping) |
| `packages/db/src/extension.test.ts` | Tests for Prisma extension |
| `packages/db/src/rls.ts` | Postgres RLS helper (`withWorkspaceRLS`, `withoutWorkspaceRLS`) |
| `packages/db/src/rls.test.ts` | RLS helper tests (9 tests) |
| `apps/web/src/lib/rate-limit.ts` | Rate limiting logic (Upstash Redis + in-memory fallback) |
| `apps/web/src/lib/rate-limit.test.ts` | Tests for rate limiting |
| `apps/web/src/lib/csp.test.ts` | CSP nonce proxy tests (14 tests: nonce uniqueness, directives, 429 responses) |
| `packages/logger/src/index.ts` | Structured JSON logger |
| `apps/web/next.config.ts` | Next.js config (output: standalone, transpile + external packages) |
| `docker-compose.yml` | Postgres 16 + Redis 7 (env-interpolated secrets, Redis password) |
| `Dockerfile` | Multi-stage Docker build (standalone output, slim runner, ARG-based build secrets) |
| `.dockerignore` | Docker build exclusions (node_modules, .next, .git, secrets, IDE dirs, docs) |
| `packages/ui/src/components.test.ts` | Unit tests for buttonVariants, badgeVariants, cn (20 tests) |
| `turbo.json` | Turborepo task definitions |
| `pnpm-workspace.yaml` | Workspace + build allowlist |
| `.env.example` | All environment variables |
| `PRD.md` | Full PRD + sprint backlog (single source of truth) |
| `NEXT-STEPS.md` | Action plan + 19 founder decisions |
| `product.md` | GTM/marketing layer |
| `engine-CHANGES.md` | Apache-2.0 §4b modification log |
| `engine-NOTICE.md` | Apache-2.0 NOTICE file |
| `packages/db/src/scoping.ts` | **(new, 2026-07-04)** pure workspace-scoping/soft-delete policy: model sets, `applyQueryGuards`, AsyncLocalStorage request context. No Prisma import (unit-testable). |

---

## 17. 2026-07-04 Audit — Batch 1 + Round-2 changes (MERGED to `main`)

A code-grounded deep audit produced these fixes, all now merged to `main`. Where this conflicts with older sections, this section wins.

- **Tenant isolation (`packages/db`)** — the workspace-scoping context was rewritten from an unsafe module-level global to **AsyncLocalStorage** in the new `packages/db/src/scoping.ts`; `extension.ts` is now a thin wrapper. **Both model sets were corrected to match real schema columns:** soft-delete = the **19** models that actually have `deletedAt` (removed `WorkspaceMember`, `CredentialSet`, `AuditLog`, `Retest`); workspace-scoped = the **17** auto-scopable models with `workspaceId` (removed `ScanEvent`, `Evidence`, `FixProposal`, `PullRequest`, `Ticket`; excluded cross-workspace `WorkspaceMember` and per-user `OnboardingState`). Auto-activation is wired into `requireWorkspaceAccess` (`packages/auth/src/session.ts`) via `setWorkspaceContext`. **Postgres RLS is a deliberate follow-up** (needs DB-validated per-request GUC). Regression + concurrency tests in `extension.test.ts` (now imports the real policy from `scoping.ts`).
- **Rate limiting (`apps/web/src/lib/rate-limit.ts`)** — now uses `UPSTASH_REDIS_REST_URL`/`_TOKEN` (the previous code passed an empty token + the `redis://` URL, silently degrading prod to per-instance in-memory). Fail-loud on init error; in-memory map is bounded by an expiry sweep.
- **GitHub webhook (`api/webhooks/github`)** — idempotent on `X-GitHub-Delivery` (pre-check + P2002 race guard); `installation.deleted` now matches targets by `startsWith("{owner}/")` instead of `contains`.
- **Onboarding (`api/onboarding`)** — PATCH verifies workspace membership + target ownership before persisting (IDOR fix).
- **GitHub install URL (`packages/integrations/src/github.ts`)** — built from `GITHUB_APP_SLUG` (was the numeric app id, which 404s).
- **CI (`.github/workflows/ci.yml`)** — adds a `pnpm test` step, reads pnpm from `packageManager`, adds `NEXT_PUBLIC_APP_URL` (landed via Codex, PR #14).

**Round-2 hardening (merged; findings in PRD §B13.7):**
- **Web security headers (`apps/web/next.config.ts`)** — `headers()` adds HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy; `poweredByHeader:false`, `reactStrictMode:true`, `images.remotePatterns` (GitHub/Google avatars). **Nonce-based CSP implemented in `proxy.ts`** (per-request nonce, `'strict-dynamic'`, `connect-src 'self'`, `blob:` in `img-src`).
- **Logger (`packages/logger`)** — now **redacts** sensitive keys (password/secret/token/authorization/apikey/privatekey/cookie/credential/vaultref/verificationurl/otp), captures `Error`, breaks circular refs, truncates oversized output. Use it freely; still never log raw secrets deliberately.
- **GitHub integration (`packages/integrations/src/github.ts`)** — installation-token **caching** (per `installationId`, using `expires_at`), retry/backoff (`githubFetch`, honors `Retry-After`), paginated `getAppInstallations`, `crypto.timingSafeEqual`.
- **Auth (`packages/auth/src/auth.ts`)** — `trustedOrigins` = `BETTER_AUTH_URL` + `ADDITIONAL_TRUSTED_ORIGINS` (comma-separated).
- **Dependabot** (`.github/dependabot.yml`) — weekly npm + github-actions; majors excluded from auto-PRs.

**✅ RESOLVED — Prisma migration drift reconciled (2026-07-05):** A reconciling migration (`20260705095000_batch3_missing_tables_columns`) now creates all missing tables (`ApiKey`, `Retest`, `OnboardingState`) and adds all missing columns/indexes/constraints. CI runs `prisma migrate diff --exit-code` to catch future drift. See §20 for details.

Remaining audit backlog (Batches 2–4) is in **PRD PART B §B13.5 / §B13.6 / §B13.7** — the PRD is the single source of truth. Round-2 handoff items (migration drift, CI hardening, supply-chain, CSP) are all **DONE** — see §20.

---

## 20. 2026-07-05 Round-2 Remaining Items — ALL COMPLETED

The four Codex handoff items from PRD §B13.7 are now done. All changes verified: `pnpm lint` ✅, `pnpm typecheck` ✅, `pnpm test` (211 tests, 12 files) ✅, `pnpm build` ✅.

### 20.1 Prisma Migration-Drift Reconciliation

- **Reconciling migration** `20260705095000_batch3_missing_tables_columns` creates all missing tables (`ApiKey`, `Retest`, `OnboardingState`) and adds all missing columns/indexes/constraints that were applied via `db push` but never captured in a migration.
- Migration runs **before** the RLS migration (`20260705100000`) which references `ApiKey` and `Retest` tables.
- **CI drift check** added: `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --exit-code` — fails CI if schema and migrations diverge.
- **Verify before prod deploy:** `prisma migrate reset && prisma migrate deploy` should reproduce `schema.prisma` exactly.

### 20.2 CI Hardening

- **Least-privilege `permissions:`** — `contents: read` at workflow level; `security-events: write` only on the security job.
- **Security job** — separate job running `pnpm audit` (advisory, `continue-on-error: true`) + **gitleaks** secret scan.
- **Migration drift check** — runs after `db:generate` and before `migrate deploy`.
- **Turbo build cache** — `actions/cache` for `.turbo` + `next` cache.

### 20.3 Supply-Chain Hardening

- **`eslint-plugin-security`** added to root `devDependencies` with 6 active rules: `detect-non-literal-regexp`, `detect-non-literal-fs-filename`, `detect-unsafe-regex`, `detect-buffer-noassert`, `detect-pseudoRandomBytes`, `detect-object-injection` (disabled — false positives in TypeScript).
- **Exact version pinning:** `better-auth` → `1.6.23`, `@prisma/client`/`prisma`/`@prisma/adapter-pg` → `7.8.0`.
- **Lockfile refreshed** after pinning.

### 20.4 Nonce-Based CSP

- **`middleware.ts` → `proxy.ts`** — renamed per Next.js 16 convention (middleware is deprecated; proxy is the new entry point). Export renamed `middleware` → `proxy`.
- **Per-request nonce** generated via `crypto.randomUUID()` → base64, set on `Content-Security-Policy` header with `'strict-dynamic'` + `'nonce-<value>'`.
- **CSP directives:** `default-src 'self'`, `script-src 'self' 'nonce-<nonce>' 'strict-dynamic'` (+ `'unsafe-eval'` in dev), `style-src 'self' 'unsafe-inline'`, `img-src 'self' blob: data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com`, `connect-src 'self'` (+ `ws:` in dev), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`, `upgrade-insecure-requests`.
- **`x-nonce` request header** set for server components; root layout calls `headers()` to force dynamic rendering.
- **CSP on all responses** — including 429 rate-limited responses (both API and auth routes).
- **14 CSP tests** in `apps/web/src/lib/csp.test.ts` (nonce uniqueness, CSP on API/non-API routes, all directives, 429 responses, x-nonce forwarding).

### 20.5 Deep Code Review (post-implementation)

- **Migration SQL** cross-referenced against `schema.prisma` — all tables, columns, indexes, constraints, and FKs match. `SOFT_DELETE_MODELS` (19) and `WORKSPACE_SCOPED_MODELS` (17) verified against schema columns.
- **RLS migration** correctly references tables created in the reconciling migration (ordering verified).
- **CI workflow** reviewed — permissions, security job, drift check, build cache all correct.
- **ESLint config** reviewed — `detect-object-injection` disabled for TypeScript false positives, 5 other rules active as warnings.
- **CSP** improved during review: added `connect-src 'self'` (was missing), `blob:` in `img-src` (for Next.js image processing), `ws:` in dev (for HMR).
- **Test count:** 211 (up from 197 — 14 CSP tests added).

### 20.6 R-G / R-I / R-E Quick Wins (2026-07-05)

**R-I: Config / correctness / a11y:**
- **`turbo.json` `globalEnv`** expanded from 8 → 35 env vars (added `NODE_ENV`, `DATABASE_DIRECT_URL`, `UPSTASH_*`, `ADDITIONAL_TRUSTED_ORIGINS`, `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`, `LYRASHIELD_*`, `LLM_API_KEY`, `S3_*`, `BREVO_*`, `EMAIL_FROM`, `POLAR_*`, `RAZORPAY_*`, `SENTRY_*`).
- **`seed.ts`** production guard — throws if `NODE_ENV=production` (prevents creating predictable demo OWNER account on prod DB).
- **`.gitignore`** — added `*.pem`, `*.key`, `*.crt`, `*.p12` (secrets/keys), `.vercel` (build artifacts).
- **`scoping.ts`** docstring on `setWorkspaceContext` updated — was stale ("nothing calls this yet"), now reflects auto-scoping is active + RLS is implemented.
- **`globals.css`** — added `color-scheme: light/dark` (native controls/scrollbars match theme) + `@media (prefers-reduced-motion: reduce)` (accessibility — disables animations/transitions).
- **`env.ts`** — added `.refine()` on `GITHUB_APP_PRIVATE_KEY` to catch `\n`-escaping footgun at boot (must contain `-----BEGIN`).
- **`docker-compose.yml`** — all ports bound to `127.0.0.1` (was `0.0.0.0`), memory limits added (Postgres 512M, Redis 256M), `# DEV ONLY` header.
- **`(dashboard)/layout.tsx`** — parallelized onboarding + workspaces queries with `Promise.all` (was sequential waterfall).

**R-E: Auth hardening:**
- **`auth.ts`** — added `cookieCache` (5min maxAge, reduces DB hits), `useSecureCookies: isProd`, explicit `sameSite: "lax"` + `secure: isProd` on `session_token` cookie `attributes`.

**R-G: Deployment doc security (`docs/deployment/PRODUCTION_DEPLOYMENT.md`):**
- **Non-root worker** — `useradd lyrashield`, `usermod -aG docker`, systemd `User=lyrashield`, `WorkingDirectory=/home/lyrashield/...`, CI deploy `username: lyrashield`.
- **SSH hardening** — `PasswordAuthentication no`, optional source-IP restriction via `ufw allow from <ip> to any port 22`.
- **TLS in connection strings** — all Postgres examples include `?sslmode=require`, Redis shows `rediss://` format with explicit URL example.
- **Backup & Restore** — new section: Postgres `pg_dump`/`pg_restore` commands + R2 object versioning enablement via `wrangler` + RPO/RTO numbers.
- **Security checklist** — 5 new items (non-root worker, SSH key-only, SSH source-IP, R2 versioning, DB backups).

### 20.7 Deferred R-I Items (2026-07-05)

**Types validation (`packages/types/src/index.ts`):**
- `.trim()` + control-char strip (`/[\u0000-\u001F\u007F]/`) on all name fields (CreateWorkspace, CreateProject, CreateRepoTarget, CreateUrlTarget).
- Regex bounds on `repoOwner`/`repoName` (`^[A-Za-z0-9_.-]+$`), `.max(255)` on `branch`.
- 11 enum-parity tests (Zod schemas vs Prisma enums) — catches migration drift at test time.
- 17 input validation tests (trim, control chars, length bounds, regex, URL validation).
- 28 new tests total (239 overall, up from 211).

**Worker hardening (`apps/worker/src/index.ts`):**
- Now imports validated `env` from `@lyrashield/config` (added as dep) instead of raw `process.env`.
- `SIGTERM`/`SIGINT` graceful shutdown handlers with idempotent guard.
- `runWithWorkspaceContext` wrapping implemented in Sprint 4 — `processScanJob` wraps all DB queries in `runWithWorkspaceContext(workspaceId, ...)` (see §21.7).

**tsconfig evaluation:**
- `verbatimModuleSyntax` evaluated — requires `"type": "module"` in all package.json files (breaking change, deferred to pre-launch).
- Root `tsconfig.json` is not orphaned (extended by `packages/config/tsconfig.json` → `library.json` chain); left as-is.

---

## 21. Sprint 4 (Scan Orchestrator + Queue) + Review Fixes (2026-07-05)

### 21.1 Scan Queue (BullMQ)

- **`apps/web/src/lib/queue.ts`** — scan job producer. `enqueueScanJob()` adds jobs to the `scans` queue with default options (3 attempts, exponential backoff, 100 complete / 200 fail retention). Imports `SCAN_QUEUE_NAME` and `ScanJobData` from `@lyrashield/types` (single source of truth).
- **`apps/worker/src/queue.ts`** — worker-side queue utilities. `getScanQueue()`, `getScanQueueEvents()`, `enqueueScan()`. Re-exports `SCAN_QUEUE_NAME`, `ScanJobData`, `ScanJobResult` from `@lyrashield/types`.
- **`apps/worker/src/types.ts`** — thin re-export layer: `export { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "@lyrashield/types"`.
- **`packages/types/src/index.ts`** — **single source of truth** for `SCAN_QUEUE_NAME`, `ScanJobData` (scanId, workspaceId, targetId, goal, mode, policyId?), `ScanJobResult` (status, summary?, errorCategory?, errorMessage?). Both web and worker import from here to prevent drift.

### 21.2 Preflight Checks (`apps/worker/src/jobs/preflight.job.ts`)

- **`runPreflight(scanId, targetId)`** — validates target existence, URL/repo configuration, and no concurrent active scans. Returns `{ passed, checks[], errorCategory?, errorMessage? }`.
- **Checks:** `target_exists` (target in DB, not soft-deleted), `url_configured` / `repo_configured` (depending on target type), `no_concurrent_scan` (no other scan in QUEUED/PREFLIGHT/RUNNING/VERIFYING for same target).
- Emits `PREFLIGHT` scan event via `addScanEvent`.
- **7 tests** in `preflight.job.test.ts` (all target types, missing target, missing URL/repo, concurrent scan).

### 21.3 Engine Runner (`apps/worker/src/engine/runner.ts`)

- **`runEngine(scanId, target, config)`** — orchestrates engine execution:
  1. Creates temp workspace dir (`lyrashield_runs/{scanId}`)
  2. Builds engine command via `buildEngineCommand()`
  3. Spawns child process with filtered env vars (`buildEngineEnv()`)
  4. Captures stdout/stderr with 10MB buffer truncation
  5. 30-minute timeout with SIGTERM → SIGKILL escalation
  6. Emits scan events for RUNNING, output capture, completion
  7. Reads `vulnerabilities.json` + `run.json` from output dir
  8. Returns `{ exitCode, output: ParsedScanOutput }`
- **`interpretExitCode(code)`** — maps engine exit codes: 0/1 → COMPLETED (SUCCESS), 2 → COMPLETED (VULNERABILITIES_FOUND), 3+ → FAILED (ENGINE_ERROR/CONFIG_ERROR/LLM_ERROR).
- **`cleanupEngineWorkspace(dir)`** — removes temp workspace (best-effort, non-fatal).
- **6 tests** in `runner.test.ts` (exit code mapping).

### 21.4 Command Builder (`apps/worker/src/engine/command-builder.ts`)

- **`buildEngineCommand(config)`** — constructs CLI args for the scan engine. Maps `TargetType` (REPO → `--repo`, WEB_APP/API → `--url`, IAC → `--url`) and `ScanMode` (SAFE → `quick`, STANDARD → `standard`, DEEP → `deep`, CUSTOM → `custom`). Adds optional `--instruction` and `--max-budget-usd` flags.
- **14 tests** in `command-builder.test.ts`.

### 21.5 Output Parser (`apps/worker/src/engine/output-parser.ts`)

- **`parseVulnerabilitiesJson(content)`** — validates and parses `vulnerabilities.json` as `EngineVulnerability[]`.
- **`parseRunJson(content)`** — parses `run.json` as `EngineRunRecord`.
- **`parseEngineOutput(vulns, run)`** — combines into `ParsedScanOutput` with summary and finding count.
- **`mapSeverity(severity)`** — normalizes severity strings to CRITICAL/HIGH/MEDIUM/LOW/INFO.
- **`generateDedupeKey(vuln, targetId)`** — creates deterministic fingerprint from targetId + CWE + endpoint + method + title.
- **`buildFindingSummary(vuln)`** — concise one-line summary.
- **21 tests** in `output-parser.test.ts`.

### 21.6 Finding Persister (`apps/worker/src/engine/finding-persister.ts`)

- **`persistFindings(params)`** — persists engine vulnerabilities as `Finding` records:
  - **Batch dedupe:** single `findMany` with `dedupeKey: { in: dedupeKeys }` instead of N individual `findFirst` calls (reduces N+1 to 1 query).
  - Updates existing findings (lastSeenAt, severity, details) or creates new ones.
  - **Evidence encryption:** PoC evidence stored as `encrypted://evidence/{findingId}/poc` URI (NOT plaintext base64 data URIs). `assertEvidenceEncrypted()` enforces that `encryptionKeyRef` is non-empty before storage.
  - Code location evidence stored with `file://` URI + `encryptionKeyRef`.

### 21.7 Scan Job Processor (`apps/worker/src/jobs/run-scan.job.ts`)

- **`processScanJob(job)`** — main entry point for BullMQ worker:
  1. Wraps entire job in `runWithWorkspaceContext(workspaceId, ...)` — ensures all DB queries are workspace-scoped via AsyncLocalStorage (defense-in-depth against cross-tenant leaks).
  2. Updates scan status → PREFLIGHT → runs preflight → RUNNING → runs engine → VERIFYING → persists findings → COMPLETED/FAILED.
  3. Error handling: catches all errors, updates scan to FAILED with errorCategory/errorMessage.
  4. Cleanup: always runs `cleanupEngineWorkspace()` in `finally` block.
- **7 tests** in `run-scan.job.test.ts` (success, preflight failure, target disappearance, engine error, unexpected error, cleanup, finding persistence).

### 21.8 Scan API Routes

- **`POST /api/scans`** — creates scan, validates target/policy, checks no concurrent scan, enqueues BullMQ job, writes audit log. Returns 201 with scan record.
- **`GET /api/scans`** — lists scans with cursor-based pagination, filters by workspaceId/targetId/status. Uses `PERMISSIONS.scan.view` (not `scan.create`) so VIEWER/AUDITOR roles can list scans.
- **`GET /api/scans/[id]`** — fetches scan with events. Uses `PERMISSIONS.scan.view`.
- **`POST /api/scans/[id]`** (cancel) — uses `PERMISSIONS.scan.cancel`, validates scan is in a cancellable state.
- **12 tests** in `route.test.ts` (POST validation, target/policy lookup, concurrent scan, enqueue success/failure, auth; GET pagination, filtering, auth).

### 21.9 Scan Detail UI (`apps/web/src/app/(dashboard)/dashboard/scans/[id]/scan-detail-client.tsx`)

- Client component with summary, target info, severity counts, findings list, events log.
- **Client-side polling:** uses `fetch("/api/scans/{id}")` every 5s for active scans (QUEUED/PREFLIGHT/RUNNING/VERIFYING/REQUIRES_APPROVAL). Updates only local `scan` state — avoids full server re-renders from `router.refresh()`.

### 21.10 Worker Index (`apps/worker/src/index.ts`)

- BullMQ `Worker` instance processing `scans` queue.
- Imports validated `env` from `@lyrashield/config` (not raw `process.env`).
- `SIGTERM`/`SIGINT` graceful shutdown handlers with idempotent guard.

### 21.11 Scan Service (`packages/db/src/scan-service.ts`)

- `createScan()` — creates scan record + initial QUEUED event.
- `updateScanStatus(scanId, status, extra?)` — validates state transition via `isValidTransition()`, updates scan, emits scan event.
- `addScanEvent()` — logs scan events.
- `getScanWithEvents(id)` — fetches scan with ordered events.
- `listScans()` — cursor-based pagination with filters.
- `cancelScan()` — validates scan is in a cancellable (non-terminal) state, updates to CANCELLED.
- **25 tests** in `scan-service.test.ts` (state machine transitions).

### 21.12 Permissions Update (`packages/auth/src/permissions.ts`)

- Added `scan.view` permission (`"scan:view"`) to the PERMISSIONS object.
- Granted to all 8 roles: OWNER (via `Object.values`), ADMIN, SECURITY_ADMIN, APPSEC_MANAGER, DEVELOPER, MEMBER, EXTERNAL_PENTESTER, AUDITOR, VIEWER.
- VIEWER and AUDITOR previously had no scan access at all — now they can view/list scans (read-only).

### 21.13 Dockerfile Cleanup

- Removed 15 lines of unused worker/shared-package copies from the runner stage. The runner stage is for the web app only (`CMD ["node", "server.js"]`). The worker runs from the builder stage via docker-compose `target: builder` (workspace packages export TypeScript source, requiring `tsx` at runtime).

### 21.14 CSP Request Header Fix (`apps/web/src/proxy.ts`)

- Removed `requestHeaders.set("Content-Security-Policy", csp)` — CSP is a response header, not a request header. It was redundantly set on request headers (non-standard) while already being set on all response objects (5 locations: non-API routes, API routes, 429 responses for both API and auth routes).

### 21.15 Test Summary

- **396 tests** across **26 test files** (up from 239 tests / 12 files pre-Sprint 4).
- New test files: `preflight.job.test.ts` (7), `run-scan.job.test.ts` (7), `route.test.ts` (12), `runner.test.ts` (6), `command-builder.test.ts` (14), `output-parser.test.ts` (21), `queue.test.ts` (5), `scan-service.test.ts` (25).
- All tests pass: `pnpm test` → 396 passed, 0 failed.

---

## §22 — 2026-07-06 Batch 4: Fix Proposals, Retests, Reports, Notifications, Schedules, Plain-Language Findings + Code Review Fixes

This section covers the Batch 4 differentiated-build features that build on top of the Sprint 4 scan orchestrator/queue, plus a comprehensive code review and all identified fixes.

### 22.1 Fix Proposals + GitHub PR Creation

**DB Service** (`packages/db/src/fix-proposal-service.ts`):
- `createFixProposal()` — creates a fix proposal linked to a finding (kind, summary, diff refs, safety score, generatedByModel).
- `getFixProposal()` — fetches proposal with associated finding and pull requests.
- `listFixProposals()` — cursor-based pagination with filters (workspaceId, findingId, status).
- `updateFixProposalStatus()` — validates status transitions.
- `createPullRequestRecord()` — links a GitHub PR to a fix proposal (provider, repo, branch, PR number/URL).
- `FixProposalWithDetails` interface for enriched proposal data.
- **11 tests** in `fix-proposal-service.test.ts`.

**API Routes**:
- `POST /api/findings/[id]/fix-proposals` — creates a fix proposal for a finding. Zod-validated, permission-checked (`fix.create`), audit-logged.
- `GET /api/fix-proposals` — lists proposals with pagination + filters.
- `POST /api/fix-proposals/[id]/create-pr` — creates a GitHub PR from a fix proposal. Fetches target/integration details, calls GitHub API (create branch, update file, create PR), updates proposal/finding status in a transaction, sends notifications. Uses `PERMISSIONS.fix.create_pr`.

**UI** (`apps/web/src/app/(dashboard)/dashboard/fixes/fixes-client.tsx`):
- Paginated list of fix proposals with status badges, severity, safety scores, PR links.
- Empty state handling.

### 22.2 Retests

**DB Service** (`packages/db/src/retest-service.ts`):
- `createRetest()` — creates a retest request for a finding (linked to the scan that found it).
- `getRetest()` — fetches retest with finding + scan details.
- `listRetests()` — cursor-based pagination with filters.
- `updateRetestStatus()` — validates status transitions (pending → running → passed/failed).
- `RetestWithDetails` interface.
- **10 tests** in `retest-service.test.ts`.

**API Routes**:
- `POST /api/findings/[id]/retests` — creates a retest. Validates no existing pending retest. Transactional with audit logging. Uses `PERMISSIONS.retest.create`.
- `GET /api/retests` — lists retests with pagination + filters.

### 22.3 Reports

**Report Generator** (`packages/db/src/report-generator.ts`):
- `ReportData` interface — structured report data (scan info, findings, severity counts, retest summary, truncation flag).
- `gatherReportData(workspaceId, scanId?)` — queries workspace, scan (optional), and findings. Findings are limited to 500 most recent (`FINDINGS_LIMIT = 500`), with a `findingsTruncated` flag set when the limit is exceeded. Severity counts, verified/fixed counts, and retest summary computed from the fetched findings.
- `generateReportHTML(data)` — renders a full HTML report with styled severity bars, findings table, scan details, and a truncation notice when applicable. All user content is HTML-escaped.
- **4 tests** in `report-generator.test.ts` (with/without scan, empty, XSS escaping).

**Report Service** (`packages/db/src/report-service.ts`):
- `createReport()` — creates a report record.
- `generateShareToken()` / `revokeShareToken()` — share token management.
- `getReportByShareToken()` / `getShareableReport()` — public report access.
- `listReports()` — cursor-based pagination.

**API Route**:
- `GET /api/reports/[id]/download` — generates and downloads the HTML report. Permission-checked (`report.download`), updates report status to "downloaded".

### 22.4 Notifications

**Integration Channels** (`packages/integrations/src/notifications.ts`):
- `NotificationChannel` type: `"email" | "slack" | "discord" | "in_app"`.
- `NotificationPayload` interface: type, title, body, workspaceName, metadata.
- `EmailChannel` — sends via Brevo API (`api.brevo.com/v3/smtp/email`). 10s timeout via `AbortSignal.timeout(10_000)`.
- `SlackChannel` — sends via Slack webhook URL. 10s timeout.
- `DiscordChannel` — sends via Discord webhook URL. 10s timeout.
- `InAppChannel` — always succeeds (record persisted in DB).
- `sendNotification(channel, payload)` — dispatches to the appropriate channel.
- `channels` map — channel registry.

**DB Service** (`packages/db/src/notification-service.ts`):
- `createNotification()` — persists a notification record (workspaceId, optional userId, channel, type, title, body, status).
- `getNotification()` / `listNotifications()` — fetch with workspace scoping + pagination.
- `markNotificationSent()` / `markNotificationRead()` / `updateNotificationStatus()` — status management with validation.
- `createAndSendNotification()` — **shared helper** that creates notification records across channels and dispatches via a `sendFn` callback. Eliminates duplication between worker and API routes. Accepts custom channels list. Used by both `apps/worker/src/notifications.ts` and `apps/web/src/app/api/fix-proposals/[id]/create-pr/route.ts`.
- **8 tests** in `notification-service.test.ts` (3 new tests for `createAndSendNotification`: success, failed send, custom channels).

**Worker Notifications** (`apps/worker/src/notifications.ts`):
- `notifyScanCompleted()` — sends "scan.completed" notification on successful scan.
- `notifyScanFailed()` — sends "scan.failed" notification on scan failure.
- `notifyCriticalFinding()` — sends "finding.critical" notification for critical-severity findings.
- All use `createAndSendNotification` from `@lyrashield/db` with `sendNotification` as the `sendFn`.

**API Routes**:
- `GET /api/notifications` — lists notifications with optional `userId` filter (worker-created notifications have no userId — they're workspace-level). Permission: `notification.view`.
- `POST /api/notifications` — creates a notification. Permission: `notification.manage`.
- `PATCH /api/notifications/[id]` — updates notification status (mark read, mark sent, general status update). Permission: `notification.manage` for status changes, `notification.view` for marking read.

**UI** (`apps/web/src/app/(dashboard)/dashboard/notifications/notifications-client.tsx`):
- Paginated notification list with channel icons, type badges (color-coded by notification type), read status.
- Mark individual notifications as read or mark all as read.
- Filter by status and type.
- `TYPE_COLORS` map typed with `NonNullable<BadgeProps["variant"]>` (no `as never` casts).

### 22.5 Schedules

**DB Service** (`packages/db/src/schedule-service.ts`):
- `createSchedule()` — creates a CRON-based scan schedule (targetId, cron, goal, mode). Uses `ScanGoal` and `ScanMode` enum types (no `as never` casts).
- `getSchedule()` — fetches schedule with target details.
- `listSchedules()` — cursor-based pagination with filters.
- `updateSchedule()` — updates cron, goal, mode, enabled flag.
- `deleteSchedule()` — soft-deletes a schedule.
- `updateScheduleRunTimes()` — updates lastRunAt/nextRunAt after a scheduled scan.
- `getDueSchedules()` — fetches schedules with `nextRunAt <= now` and `enabled = true`.
- `ScheduleWithDetails` interface.
- **7 tests** in `schedule-service.test.ts`.

**Migration** (`packages/db/prisma/migrations/20260706010000_schedule_target_fk/migration.sql`):
- Adds the missing `Schedule_targetId_fkey` foreign key constraint (`Schedule.targetId` → `Target.id`, `ON DELETE CASCADE`).

**API Routes**:
- `GET /api/schedules` — lists schedules with pagination. Permission: `schedule.view`.
- `POST /api/schedules` — creates a schedule. Validates target existence, uniqueness of active schedules per target. Permission: `schedule.create`.
- `GET /api/schedules/[id]` — fetches a single schedule. Permission: `schedule.view`.
- `PATCH /api/schedules/[id]` — updates a schedule. Permission: `schedule.update`.
- `DELETE /api/schedules/[id]` — soft-deletes a schedule. Permission: `schedule.delete` (ADMIN+ only, not MEMBER).

**UI** (`apps/web/src/app/(dashboard)/dashboard/schedules/schedules-client.tsx`):
- Full CRUD UI for schedules with form (cron expression, goal selector, mode selector, target selector).
- Enable/disable toggle, delete with confirmation.
- Paginated list with badges and timestamps.

### 22.6 Plain-Language Findings

**Plain-Language Explainer** (`apps/web/src/lib/plain-language.ts`):
- `PlainLanguageFinding` interface — title, whatItIs, whyItMatters, howToFix, difficulty, estimatedTimeToFix.
- `CWE_EXPLANATIONS` — maps 8 common CWE IDs (CWE-79, 89, 352, 287, 22, 798, 200, 918) to plain-language explanations.
- `GENERIC_EXPLANATIONS` — maps severity levels (CRITICAL, HIGH, MEDIUM, LOW, INFO) to generic explanations.
- `CATEGORY_LABELS` — maps category strings (injection, xss, csrf, ssrf, auth, crypto, config, disclosure, access_control, deserialization, dependencies, secrets) to human-readable labels.
- `explainFinding(params)` — looks up by CWE first, falls back to severity-based generic. Wires up `category` (for better fallback titles) and `technicalDetail` (appended to `whatItIs` as "Technical detail: ..."). Overrides `howToFix` with `recommendedFix` when provided.
- **6 tests** in `apps/worker/src/engine/plain-language.test.ts`.

### 22.7 Permissions Update

**Permissions** (`packages/auth/src/permissions.ts`):
- Added permissions for new features: `fix.create`, `fix.view`, `fix.create_pr`, `fix.update`, `retest.create`, `retest.view`, `retest.update`, `report.create`, `report.view`, `report.download`, `notification.view`, `notification.manage`, `schedule.view`, `schedule.create`, `schedule.update`, `schedule.delete`.
- **MEMBER role** restricted: `notification.manage` and `schedule.delete` removed. Members retain view/create/update for schedules and view for notifications. ADMIN/SECURITY_ADMIN/BILLING_ADMIN retain all permissions.

### 22.8 Code Review Fixes (P1/P2/P3)

A comprehensive code review identified 10 issues across the new features. All fixed:

**P1 — Critical:**
1. **Missing migration for `Schedule.target` FK** — Created `20260706010000_schedule_target_fk/migration.sql` adding the `Schedule_targetId_fkey` foreign key constraint. CI's `migrate diff` drift check will now pass.
2. **In-app notifications invisible** — Worker-created notifications (scan completed, critical finding, fix PR) have no `userId` (they're workspace-level). The notifications list API was filtering by `session.userId` by default, making them invisible. Fixed by removing the default `userId` filter and adding an optional `userId` query parameter.

**P2 — High Priority:**
3. **`createPullRequestRecord` bypassed transaction** — In `create-pr/route.ts`, the PR record was created via `createPullRequestRecord()` outside the `$transaction`, risking orphaned records if subsequent steps failed. Fixed by inlining `tx.pullRequest.create()` inside the transaction.
4. **Permissive MEMBER permissions** — `notification.manage` and `schedule.delete` were granted to MEMBER role, allowing members to manage notification settings and delete schedules. Removed from MEMBER; ADMIN+ only.
5. **No timeout on external HTTP calls** — Brevo, Slack, and Discord `fetch` calls had no timeout, risking indefinite hangs. Added `AbortSignal.timeout(10_000)` (10s) to all notification channel calls and `AbortSignal.timeout(30_000)` (30s) to `githubFetch` (GitHub API wrapper).
6. **Unbounded `findMany` in report generator** — `gatherReportData` fetched all findings with no limit, risking OOM for large workspaces. Added `take: FINDINGS_LIMIT + 1` (500) with a `findingsTruncated` boolean in `ReportData` and a user-visible truncation notice in the HTML report.

**P3 — Quality:**
7. **`explainFinding` ignored params** — `category` and `technicalDetail` parameters were accepted but unused. Fixed: `category` maps to human-readable labels via `CATEGORY_LABELS` for better fallback titles; `technicalDetail` is appended to `whatItIs` as "Technical detail: ...".
8. **`as never` casts** — Replaced with proper type casts: `as ScanGoal`/`as ScanMode` in `schedule-service.ts` (importing the enum types from generated Prisma), and `NonNullable<BadgeProps["variant"]>` in `notifications-client.tsx` (importing `BadgeProps` from `@lyrashield/ui`).
9. **Duplicate notification logic** — `createAndSendNotification` logic was duplicated between `apps/worker/src/notifications.ts` and the `create-pr` API route. Extracted into `packages/db/src/notification-service.ts` as a shared function with a `sendFn` callback (avoids cross-package dependency). Both consumers now use it. 3 new tests added.
10. **Dead cleanup effect in findings-client** — `FindingDetailModal` had a `useEffect` that reset state on unmount — unnecessary since React handles this automatically. Removed.

### 22.9 Test Summary

- **565 tests** across **44 test files** (up from 396 tests / 26 files pre-Batch 4).
- New test files: `fix-proposal-service.test.ts` (11), `retest-service.test.ts` (10), `schedule-service.test.ts` (7), `report-generator.test.ts` (4), `notification-service.test.ts` (8, 3 new for `createAndSendNotification`), `plain-language.test.ts` (6), `api-client.test.ts` (13), `launch-readiness.test.ts` (8), `rate-limit.test.ts` (8), `ssrf.test.ts` (35), `prompt-injection-guard.test.ts` (9), `github.test.ts` (9), `secret-scanner.test.ts` (10), `sca-scanner.test.ts` (8), `sarif-generator.test.ts` (6), `verifier.test.ts` (13), `runner.test.ts` (6), `queue.test.ts` (5), `preflight.job.test.ts` (7), `run-scan.job.test.ts` (7), `scan-service.test.ts` (25), `audit-hash.test.ts` (21), `components.test.ts` (UI).
- All tests pass: `pnpm test` → 565 passed, 0 failed.
- `pnpm lint` → 0 errors. `pnpm typecheck` → 0 errors. `pnpm build` → 3/3 successful.

---

## 23. Sprint 6/6.5 — Findings Normalization + SCA + Secrets Scanning + Scanner Orchestrator (2026-07-06)

**Sprint 5 (Engine MVP)** was already complete — the external `lyrashield-engine` binary is wired via `runner.ts` (child process spawn) + `command-builder.ts` (CLI arg construction). No new code needed.

### 23.1 Findings Normalization (`apps/worker/src/engine/normalizer.ts`)

A normalization pipeline that processes raw `EngineVulnerability` objects into a unified `NormalizedFinding` format with enrichment and quality scoring.

**Exported functions:**

- `normalizeSeverity(severity: string): string` — Maps to CRITICAL/HIGH/MEDIUM/LOW/INFO. Handles variations like "crit", "warning", "note", "informational".
- `normalizeCwe(cwe: string | undefined): string | undefined` — Strips prefixes, zero-pads to 4 digits. `"cwe-79"` → `"CWE-0079"`.
- `enrichCwe(cwe: string): CweMetadata` — Returns `{ title, owaspCategory, description }` from a 40+ entry CWE lookup table covering CWE-79 (XSS), CWE-89 (SQLi), CWE-352 (CSRF), CWE-1104 (Use of Maintained Third-Party Components), etc.
- `calculateCvssFromSeverity(severity: string): number` — Estimates CVSS v3.1 base score: CRITICAL=9.5, HIGH=7.5, MEDIUM=5.0, LOW=2.5, INFO=0.
- `calculateConfidenceScore(vuln: EngineVulnerability): number` — 0-100 score based on evidence: PoC script (+30), PoC description (+20), code location with fix diff (+25), CVE/CWE identifiers (+15), technical analysis (+10). Max=100.
- `assessFalsePositiveRisk(vuln: EngineVulnerability): "high" | "medium" | "low"` — Returns "high" if target URL contains test-environment indicators (`localhost`, `example.com`, `test`, `demo`, `127.0.0.1`). Returns "low" if PoC evidence exists on real targets. Otherwise "medium".
- `calculateRemediationPriority(severity: string, confidence: number): number` — 1 (highest) to 4 (lowest). CRITICAL+high-confidence=1, INFO=4.
- `normalizeFindings(vulns: EngineVulnerability[]): NormalizedFinding[]` — Full pipeline: normalize severity, enrich CWE, calculate CVSS + confidence + false-positive risk + remediation priority, deduplicate by dedupe key (keeping higher severity on conflict, using confidence as tiebreaker).
- `filterFalsePositives(findings: NormalizedFinding[]): NormalizedFinding[]` — Removes findings with `falsePositiveRisk: "high"`. Logs removed count.
- `getFindingStats(findings: NormalizedFinding[]): FindingStats` — Aggregates counts by severity, total, verified count, average confidence, average CVSS.

**Types exported:** `NormalizedFinding`, `CweMetadata`, `FindingStats`.

**Tests:** `normalizer.test.ts` — 14 tests covering all functions including severity mapping edge cases, CWE normalization, false-positive risk assessment for test vs real targets, confidence scoring with varying evidence, deduplication with severity conflicts, filtering, and stats calculation.

### 23.2 SCA Scanner (`apps/worker/src/engine/scanners/sca-scanner.ts`)

Software Composition Analysis scanner that parses dependency files and queries the OSV (Open Source Vulnerabilities) API for known vulnerabilities.

**Supported dependency file formats:**
- `package.json` (npm) — dependencies + devDependencies
- `package-lock.json` (npm) — packages array
- `requirements.txt` (PyPI) — `name==version`, `name>=version`, `name~=version`
- `go.mod` (Go) — `module name version` + `require` blocks
- `Cargo.toml` (Cargo) — `[dependencies]` + `[dev-dependencies]` sections
- `Gemfile` (RubyGems) — `gem "name", "version"` syntax
- `composer.json` (Packagist) — require + require-dev sections

**Exported functions:**

- `scanSca(config: ScaScanConfig): Promise<EngineVulnerability[]>` — Main entry point. Finds dependency files, parses them, queries OSV for each dependency, deduplicates by vulnerability ID, returns `EngineVulnerability[]` with CWE-1104 tagging, fixed version in remediation steps, and CVE IDs extracted.
- `queryOsv(dependency: Dependency, fetchFn?: typeof fetch): Promise<OsvVulnerability[]>` — Queries `https://api.osv.dev/v1/query` with 10s timeout via `AbortController`. Accepts optional `fetchFn` for testability (defaults to global `fetch`).

**Internal functions:** `findDependencyFiles`, `parseDependencyFile`, `parsePackageJson`, `parsePackageLockJson`, `parseRequirementsTxt`, `parseGoMod`, `parseCargoToml`, `parseGemfile`, `parseComposerJson`, `mapOsvSeverity`, `extractCveId`, `extractFixedVersion`.

**Design decisions:**
- Injectable `fetchFn` on both `ScaScanConfig` and `queryOsv` — avoids `vi.stubGlobal` issues in tests; production code passes `undefined` and uses global `fetch`.
- Severity mapping: checks `database_specific.severity` first (GHSA convention), then parses CVSS vector string score, then falls back to severity array, defaults to "medium".
- Deduplication by vulnerability ID across all dependencies (same CVE affecting multiple packages = one finding).

**Tests:** `sca-scanner.test.ts` — 5 tests: empty repo (no dep files), package.json parsing with mock OSV response, requirements.txt parsing, OSV API failure graceful handling, deduplication by shared vulnerability ID. Uses `makeMockFetch` helper that returns real `Response` objects keyed by `name@version`.

### 23.3 Secrets Scanner (`apps/worker/src/engine/scanners/secrets-scanner.ts`)

Regex-based hardcoded secrets detector that walks repository files and matches against 12 secret patterns.

**Secret patterns detected:**
1. AWS Access Key IDs (`AKIA[0-9A-Z]{16}`)
2. AWS Secret Access Keys (40-char base64 after `aws_secret_access_key`)
3. GitHub tokens (`gh[pousr]_[A-Za-z0-9]{36}`)
4. Private keys (PEM blocks: `-----BEGIN ... PRIVATE KEY-----`)
5. Slack tokens (`xox[baprs]-[A-Za-z0-9-]+`)
6. Database connection strings with credentials (`postgres://user:pass@`, `mongodb://user:pass@`, `mysql://user:pass@`)
7. Hardcoded passwords (`password = "..."`, `password: "..."` — with false-positive filtering)
8. Stripe secret keys (`sk_live_[A-Za-z0-9]+`)
9. Stripe restricted keys (`rk_live_[A-Za-z0-9]+`)
10. JWT tokens (`eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
11. Generic API keys (`api_key = "..."`, `apikey: "..."`)
12. Google API keys (`AIza[0-9A-Za-z_-]{35}`)

**Exported functions:**

- `scanSecrets(config: SecretsScanConfig): Promise<EngineVulnerability[]>` — Walks repo, reads files, matches patterns, redacts matched secrets in output, filters false positives, returns findings with file path + line number in code locations.

**Internal functions:** `walkDir`, `scanFile`, `redactSecret`, `isFalsePositive`, `getFileExtension`, `getLanguageFromExt`.

**False-positive filtering:** Checks for hint substrings in surrounding context: `example`, `sample`, `demo`, `test`, `placeholder`, `dummy`, `fake`, `xxx`, `your-`, `<`, `{`, `secret` (case-insensitive). If any hint is found near the match, the finding is dropped.

**Ignored paths:** `node_modules`, `.git`, `dist`, `build`, `.next`, `vendor`, `.cache`, `.env.example`, `.env.sample`.

**Ignored file extensions:** `.min.js`, `.map`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.ico`, `.svg`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.mp4`, `.webm`, `.zip`, `.tar`, `.gz`, `.lock`, `.sum`.

**Max file size:** 512KB (`MAX_FILE_SIZE`).

**Tests:** `secrets-scanner.test.ts` — 12 tests: empty repo, AWS key detection, GitHub token, PEM private key, Slack token, DB connection string, hardcoded password, Stripe key, node_modules/.git skip, binary file skip, false-positive hint filtering, code location with line number.

### 23.4 Scanner Orchestrator (`apps/worker/src/engine/scanner-orchestrator.ts`)

Coordinates execution of the engine, SCA scanner, and secrets scanner in parallel, then normalizes and merges all findings.

**Exported functions:**

- `runScannerOrchestrator(config: ScannerOrchestratorConfig): Promise<ScannerOrchestratorResult>` — Runs `scanSca` and `scanSecrets` in parallel (engine findings passed in from completed engine run). Normalizes all findings via `normalizeFindings`, filters false positives via `filterFalsePositives`, calculates stats via `getFindingStats`, sorts by severity (CRITICAL first), returns `{ findings, stats }`.

**Error handling:** If SCA or secrets scanner throws, logs the error and continues with findings from the other scanners. Engine findings are always included (they come pre-computed).

**Types exported:** `ScannerOrchestratorConfig`, `ScannerOrchestratorResult`.

**Tests:** `scanner-orchestrator.test.ts` — 5 tests: all scanners merge correctly, severity normalization applied, stats calculated, empty engine findings handled, SCA scanner failure handled gracefully (engine + secrets still returned).

### 23.5 Integration into Scan Job (`apps/worker/src/jobs/run-scan.job.ts`)

The `processScanJob` function was updated to call `runScannerOrchestrator` after the engine run completes:

1. Engine runs (existing flow: preflight → run engine → parse output)
2. `runScannerOrchestrator` is called with engine findings + repo path + workspace dir
3. Orchestrator runs SCA + secrets in parallel, normalizes all findings, filters false positives
4. `persistFindings` is called with the combined normalized findings
5. Scan event logged with per-scanner counts (engine, SCA, secrets)

**Finding persister update:** `finding-persister.ts` now accepts both `EngineVulnerability` and `NormalizedFinding` types. It checks for `dedupeKey` property to determine if a finding is already normalized, and uses the appropriate fields accordingly.

**Tests:** `run-scan.job.test.ts` — 7 tests (updated): mocks `runScannerOrchestrator`, verifies it's called after engine run, verifies normalized findings are persisted. Existing tests for preflight failure, target disappearance, engine error, unexpected error, and cleanup still pass.

### 23.6 ESLint Security Rules

All scanner files have file-level `eslint-disable` comments for `security/detect-non-literal-fs-filename`, `security/detect-unsafe-regex`, and `security/detect-non-literal-regexp` where applicable. These rules fire on scanner code that inherently uses dynamic file paths and regex patterns (repo walking, dependency file parsing, secret pattern matching). The disables are scoped to the specific files that need them.

### 23.7 Test Summary

- **653 tests** across **52 test files** (up from 565 tests / 44 files pre-Sprint 6/6.5).
- New test files: `normalizer.test.ts` (14), `sca-scanner.test.ts` (5), `secrets-scanner.test.ts` (12), `scanner-orchestrator.test.ts` (5). Updated: `run-scan.job.test.ts` (7, mocks added for orchestrator).
- All tests pass: `pnpm test` → 653 passed, 0 failed.
- `pnpm lint` → 0 errors, 0 warnings. `pnpm typecheck` → 0 errors. `pnpm build` → 3/3 successful.

---

## §24 — Sprint 7: Tier 2 (AI-Builder-Aware URL Scan + Launch-Readiness UI + Shareable Report/Badge + MCP Server + Prompt-Injection Defense + GitHub Action Diff-Gate)

**Date:** 2026-07-06

### 24.1 AI-Builder-Aware URL Scanner (`url-scanner.ts`)

**File:** `apps/worker/src/engine/scanners/url-scanner.ts`

A new scanner that fetches the target URL and analyzes the HTML + response headers for security issues common in AI-builder-generated applications (Lovable, Bolt, v0, Replit, etc.).

**10 detectors:**

1. **Supabase anon key exposure** — Detects JWT tokens alongside `*.supabase.co` URLs in HTML. Flags as HIGH/CWE-200 with guidance to verify RLS policies. References CVE-2025-48757 (Lovable incident) in technical analysis.

2. **Firebase config exposure** — Detects `firebaseConfig` with embedded API key. Flags as MEDIUM/CWE-200 with guidance to review Security Rules and restrict API key to domain.

3. **Exposed API keys** — Pattern-matches Stripe (`sk_live_`), AWS (`AKIA`), GitHub (`ghp_/ghs_/gho_/ghu_/ghr_`), Google (`AIza`), and generic API keys in HTML source. Flags as HIGH/CWE-200.

4. **Missing security headers** — Checks for `content-security-policy`, `strict-transport-security`, `x-frame-options`, `x-content-type-options`. Flags as MEDIUM or LOW/CWE-693.

5. **CORS misconfiguration** — Detects `Access-Control-Allow-Origin: *` (LOW) and wildcard + credentials (HIGH/CWE-942).

6. **IDOR patterns** — Detects numeric IDs in API URLs (`/api/users/123`, `?id=123`, `?user_id=123`). Flags as MEDIUM/CWE-639 with guidance to use UUIDs and server-side authorization.

7. **Missing webhook verification** — Detects webhook endpoints (Stripe, GitHub) without signature verification logic. Checks both HTML and repo files. Flags as HIGH/CWE-345.

8. **AI builder defaults** — Detects platform markers (lovable, bolt.new, v0.dev, replit, base44, cursor, windsurf) in HTML. Flags as INFO/CWE-693 with comprehensive security review recommendations.

9. **Open redirects** — Detects redirect parameters (`redirect=`, `next=`, `return_url=`, `callback=`) and dynamic `window.location` assignments. Flags as MEDIUM/CWE-601.

10. **Repository webhook file check** — Scans `src/app/api/webhooks/stripe/route.ts`, `src/app/api/webhooks/github/route.ts`, etc. for missing signature verification.

**Integration:** Wired into `scanner-orchestrator.ts` — runs in parallel with SCA and secrets scanners when `target.url` is present. Results normalized, filtered, and merged with engine + SCA + secrets findings. `ScannerOrchestratorResult` now includes `urlFindings` field.

**Tests:** `url-scanner.test.ts` — 11 tests covering Supabase key detection, Firebase config, missing headers, headers present (no false positive), CORS wildcard + credentials, IDOR patterns, AI builder markers, open redirects, Stripe key exposure, fetch failure, null fetch response.

### 24.2 Launch-Readiness UI

**Files:**
- `apps/web/src/app/(dashboard)/dashboard/launch-readiness/page.tsx` — Server component, fetches session + workspaceId
- `apps/web/src/app/(dashboard)/dashboard/launch-readiness/launch-readiness-client.tsx` — Client component with score gauge, verdict card, severity breakdown

**Features:**
- **Score gauge** — SVG circle gauge (0-100) with color-coded score (green ≥80, amber ≥40, red <40)
- **Verdict card** — GO (green, ShieldCheck icon), GO_WITH_CONDITIONS (amber, ShieldAlert), NO_GO (red, ShieldX) with summary, score, total/blocking/verified finding badges
- **Conditions & recommendations** — Two-column card layout with bullet lists
- **Severity breakdown** — Horizontal bar chart with color-coded severity counts
- **All clear state** — CheckCircle2 icon with "No Security Issues Found" message
- **Sidebar nav** — "Launch Readiness" with Rocket icon added to sidebar

**API:** Uses existing `GET /api/launch-readiness?workspaceId=...` endpoint (already built in prior sprint).

### 24.3 Shareable Report Public Page + Badge

**Files:**
- `apps/web/src/app/reports/shared/[id]/page.tsx` — Public server component, validates share token via `getReportByShareToken`, fetches `getShareableReport`
- `apps/web/src/app/reports/shared/[id]/shared-report-view.tsx` — Public report view with security badge

**Features:**
- **Security badge** — PASS (green, ShieldCheck), PASS_WITH_WARNINGS (amber, ShieldAlert), FAIL (red, ShieldAlert) based on findings count and critical findings
- **Report header** — Title, type, generated date, target name
- **Scan summary** — Status, findings count, summary text
- **Findings by severity** — Color-coded severity badges with counts
- **Footer** — Report ID, "Powered by LyraSec AI" branding
- **Expiry notice** — Shows share link expiration date if set
- **No auth required** — Public route accessible via `/reports/shared/{id}?token={token}`

### 24.4 MCP Server — Real API Calls + Stdio Transport

**Files:**
- `packages/mcp/src/tools.ts` — Rewritten: tools now use `ToolHandlerContext` (apiBaseUrl, apiKey, fetchFn) to make real API calls
- `packages/mcp/src/server.ts` — Updated to use `createAllTools(context)` factory, accepts `toolContext` in options
- `packages/mcp/src/stdio-transport.ts` — New: JSON-RPC 2.0 over stdin/stdout transport entry point
- `packages/mcp/src/index.ts` — Updated exports
- `packages/mcp/package.json` — Added `bin` entry for `lyrashield-mcp` CLI

**Tool factory pattern:** Each tool is now created via `createScanTargetTool(context)`, `createGetFindingsTool(context)`, etc. The `createAllTools(context)` factory returns all 4 tools. This enables:
- Injectable `fetchFn` for testing
- Configurable API base URL via `LYRASHIELD_API_URL` env var
- Optional API key via `LYRASHIELD_API_KEY` env var
- 30s timeout on all API calls via `AbortController`

**Stdio transport:** Implements MCP protocol over stdin/stdout with JSON-RPC 2.0:
- `initialize` — Returns server info + protocol version + capabilities
- `tools/list` — Returns available tools
- `tools/call` — Calls a tool by name with args (goes through prompt injection guard)
- `shutdown` — Graceful shutdown

**Tests:** `tools.test.ts` — 5 tests covering scan trigger, API failure handling, findings query with params, launch readiness fetch, report creation. All use mock `fetchFn`.

### 24.5 Prompt-Injection Defense (already built)

**File:** `packages/mcp/src/prompt-injection-guard.ts` (unchanged from prior sprint)

27 injection patterns including instruction override, role hijack, code execution, SQL injection, env extraction, XSS vectors, destructive commands, prompt extraction. `checkToolCall()` serializes and checks tool args. Strict mode sanitizes suspicious but non-critical patterns with `[REDACTED]` replacement.

**Tests:** `prompt-injection-guard.test.ts` — 9 tests (unchanged).

### 24.6 GitHub Action Diff-Gate (already built)

**File:** `.github/workflows/lyrashield-scan.yml` (unchanged from prior sprint)

Workflow runs on PRs, checks diffs for:
- Secrets in changed files (regex patterns)
- Vulnerable dependencies (`npm audit`, `safety check`)
- Common code security issues (hardcoded secrets, SQL injection, disabled security controls, eval/exec usage)
- Generates SARIF output and provides diff-gate decision

### 24.7 Test Summary

- **691 tests** across **56 test files** at time of Sprint 7 (up from 669 tests / 54 files pre-Sprint 7, 653/52 pre-Sprint 6.5, 565/44 pre-Batch 4). Later increased to 727 tests after AI pipeline audit — see §26.4.
- New test files: `url-scanner.test.ts` (11), `tools.test.ts` (5). Updated: `scanner-orchestrator.test.ts` (5, URL scanner mock added, expectations updated).
- All tests pass: `pnpm test` → 691 passed, 0 failed (at time of Sprint 7; now 727 after AI pipeline audit).
- `pnpm lint` → 0 errors, 0 warnings. `pnpm typecheck` → 0 errors. `pnpm build` → 3/3 successful.

### 24.8 Docker Deployment Verified

Full-stack Docker deployment tested and verified:
- **5 containers** build and run: `lyrashield-postgres` (healthy), `lyrashield-redis` (healthy), `lyrashield-migrate` (exited 0), `lyrashield-web` (running), `lyrashield-worker` (running)
- **7 Prisma migrations** applied successfully (including `agent_approval_layer`), 30 tables created, 18 RLS-enabled
- **All 12 dashboard pages** return 200 (authenticated): dashboard, projects, targets, scans, findings, reports, notifications, schedules, team, settings, integrations, launch-readiness, fixes
- **All 10 API endpoints** return `success: true`: projects, targets, scans, findings, reports, notifications, schedules, team, launch-readiness, fix-proposals
- **Auth flow**: sign-up → email verification → sign-in → session cookies set correctly
- **Scan lifecycle**: QUEUED → PREFLIGHT → RUNNING → FAILED (expected — engine binary not mounted in Docker)
- **Security headers verified**: CSP with per-request nonce, X-Frame-Options DENY, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- **781 tests pass inside container** (at time of Agent Action Layer; see §26.5 and §27 for later verifications)
- **Unauthenticated API access** correctly returns 401
- **404 pages** return 404 correctly

## §25 — UI/UX Refinement Sweep (2026-07-06)

**Date:** 2026-07-06

### 25.1 FormField Component Migration

Raw `<label>` elements replaced with shared `FormField` component from `@lyrashield/ui` across:
- `apps/web/src/app/sign-in/page.tsx`
- `apps/web/src/app/sign-up/page.tsx`
- `apps/web/src/app/onboarding/onboarding-wizard.tsx`
- `apps/web/src/app/(dashboard)/dashboard/scans/scans-client.tsx`
- `apps/web/src/app/(dashboard)/dashboard/schedules/schedules-client.tsx`

### 25.2 Design Token Migration

Raw color classes replaced with design tokens across all dashboard pages:
- `text-gray-*` → `text-muted-foreground`
- `text-red-*` / `bg-red-*` → `destructive` token
- `text-blue-*` → `text-primary` or `text-sky-*` (semantic)
- `text-green-600` → `text-emerald-*` (semantic)
- `text-yellow-*` / `bg-yellow-*` → `text-amber-*` (semantic)
- `border-gray-*` → `border-border` token

Files updated: `shared-report-view.tsx`, `scan-detail-client.tsx`, `launch-readiness-client.tsx`, `findings-client.tsx`

### 25.3 Accessibility Improvements

- `aria-hidden="true"` added to all decorative icons (RefreshCw, Plus, Check, etc.) in `github-integration.tsx`
- `tracking-tight` added to all page headings (sign-in, sign-up, integrations)
- `Spinner` component used in all loading states
- `sr-only` text added to dashboard loading skeleton for screen readers

### 25.4 Test Count

- **727 tests** across **56 test files** (up from 691/56 pre-audit).
- No new test files added in this sweep — changes were UI-only (component swaps, color token replacements, accessibility attributes).
- All tests pass: `pnpm test` → 727 passed, 0 failed.

## §26 — AI Pipeline Audit Fixes + Fresh Docker Verification (2026-07-06)

**Date:** 2026-07-06

### 26.1 Multi-Domain Code Review (Round 1)

A comprehensive code review was performed across all working changes spanning the worker engine, MCP server, frontend, and docs. 11 issues identified and fixed:

**P1 (Critical):**
- `secrets-scanner.ts` — Secret leaks in `poc_description` and `code_locations.snippet` fixed by redacting secret prefixes and replacing code snippets with `[REDACTED]` message.

**P2 (Important):**
- `url-scanner.ts` — HTTP header case-insensitivity fixed by normalizing headers to lowercase before security header detection.
- `url-scanner.ts` — SSRF protection added: blocks private IPs (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16) and non-HTTP protocols (file://, ftp://).
- `scanner-orchestrator.ts` — Cross-source deduplication: when the same finding is found by multiple scanners, the higher-severity one is kept.
- `sca-scanner.ts` — Lock files removed from dependency file patterns to avoid incorrect parsing.
- `run-scan.job.ts` — `workspaceDir` explicitly passed to scanner orchestrator to unify workspace usage.
- `finding-persister.ts` — Normalizer `confidenceScore` and `normalizedCwe` used for persistence instead of verifier overwrite.

**P3 (Minor):**
- `launch-readiness-client.tsx` — Deduplicated fetch logic by using `loadReport` callback in `useEffect`; removed synchronous `setLoading(true)` in effect.
- `mcp/tools.ts` — Added `res.ok` check before parsing JSON in `apiCall` to handle non-OK HTTP responses gracefully.
- `run-scan.job.ts` — Fixed duplicate comment numbering and indentation of try/catch block.
- `sidebar.tsx` — Replaced `queueMicrotask` with lazy `useState` initializer for localStorage read; removed unused `useEffect` import.

### 26.2 Full Codebase Review (Round 2)

9 additional issues identified and fixed:

- `findings/[id]/route.ts` — Consolidated double `requirePermission` calls.
- `auth.ts` — HTML-escaped `user.name` in email verification content to prevent injection.
- `api-client.ts` — Fixed to not throw on `success: true` with undefined `data`.
- `ci.yml` — Tightened `pnpm audit` to fail on critical vulnerabilities; removed `continue-on-error`.
- `notification-service.ts` — Fixed cursor pagination to safely handle cases when fewer items than limit are returned.
- `run-scan.job.test.ts` — Added test for `VERIFYING` status transition.
- `sidebar.tsx` — Fixed lint warning on `setState` in effect.
- `scanner-orchestrator.test.ts` — Added test for cross-source deduplication.
- `url-scanner.test.ts` — Added regression tests for header case-insensitivity and SSRF blocking.

### 26.3 AI Pipeline Audit (Round 3)

Full AI pipeline audit covering LLM API calls, AI model integration, prompt construction, structured output parsing, AI engine invocation, and cost/latency controls. 7 issues identified and fixed:

**HIGH:**
1. **Engine env var prefix allowlist** (`runner.ts`) — Added allowlist for `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` env vars passed to the engine subprocess. Previously, all env vars with matching prefixes were passed; now only explicitly allowlisted vars are forwarded, preventing accidental secret leakage to the engine process.
2. **Schema validation for engine output** (`output-parser.ts`) — Added validation for severity (must be CRITICAL/HIGH/MEDIUM/LOW/INFO), CVSS (0.0–10.0 range), and CWE format (CWE-NNN or bare number). Invalid entries are removed with warnings. CWE format is normalized including bare numbers.

**MEDIUM:**
3. **Narrowed false-positive patterns** (`normalizer.ts`) — False-positive pattern matching narrowed to only `target` and `endpoint` fields instead of all string fields. Prevents legitimate findings from being flagged as false positives due to keywords in description or title.
4. **LLM usage tracking** (`run-scan.job.ts`) — Parses `llm_usage` from engine output and persists it as a `ScanEvent` with `llm_usage` metadata. Enables cost monitoring and budget enforcement.
5. **MCP tool call audit logging** (`server.ts`) — Added structured audit logging for MCP tool calls. Both allowed and blocked calls are logged with redacted args (tool name, args summary, timestamp, result status). Blocked calls from prompt injection guard are logged at warn level.

**LOW:**
6. **`technicalDetail` in CWE-specific path** (`plain-language.ts`) — Appended `technicalDetail` in the CWE-specific explanation path for consistency with the generic path. Previously, `technicalDetail` was only appended in the generic fallback path.
7. **Golden-file regression test** (`normalizer.test.ts`) — Added a comprehensive golden-file regression test that runs the full normalization pipeline (severity → CWE → CVSS → confidence → false-positive risk → dedup) on a representative set of findings and verifies the output matches expected golden values.

### 26.4 Test Summary

- **727 tests** across **56 test files** (up from 691/56 pre-audit, +36 new tests).
- New/updated test files: `output-parser.test.ts` (+6 tests: severity/CVSS/CWE validation), `normalizer.test.ts` (+2 tests: golden-file, title-only FP), `secrets-scanner.test.ts` (+2 tests: poc_description + snippet redaction), `url-scanner.test.ts` (+5 tests: mixed-case headers, SSRF localhost/192.168/10.x/file), `scanner-orchestrator.test.ts` (+1 test: cross-source dedup), `run-scan.job.test.ts` (+2 tests: VERIFYING transition, workspaceDir), `tools.test.ts` (+2 tests: non-OK HTTP error handling), `api-client.test.ts` (1 updated: undefined data returns undefined).
- All tests pass: `pnpm test` → 727 passed, 0 failed.
- `pnpm lint` → 0 errors, 0 warnings. `pnpm typecheck` → 0 errors. `pnpm build` → 3/3 successful.

### 26.5 Fresh Docker Verification (2026-07-06)

Full-stack Docker deployment tested and verified with fresh build (`docker compose down -v && docker compose build --no-cache && docker compose up -d`):

- **3 Docker images** built successfully: `lyrashieldai-web`, `lyrashieldai-worker`, `lyrashieldai-migrate` (152.8s build time).
- **5 containers** running: `lyrashield-postgres` (healthy), `lyrashield-redis` (healthy), `lyrashield-migrate` (exited 0), `lyrashield-web` (running), `lyrashield-worker` (running).
- **7 Prisma migrations** applied successfully (including `agent_approval_layer`), 30 tables created, 18 RLS-enabled.
- **18 pages** tested: 3 return 200 (landing, sign-in, sign-up), 14 return 307 (auth redirect — expected for dashboard pages without session), 1 returns 404 (non-existent route — expected). **0 failures.**
- **13 API endpoints** tested: 6 return 400 (missing workspaceId/params — correct), 5 return 401 (auth required — correct), 2 return 400 (validation error — correct). **0 unexpected failures.**
- **Scan lifecycle** verified: QUEUED → PREFLIGHT (3/3 checks passed) → RUNNING (engine started) → FAILED (`spawn lyrashield ENOENT` — expected without engine binary). 6 ScanEvent records created with stage/level/message. AuditLog entry created (`scan.created`).
- **Worker logs** verified: structured JSON with scanId, status transitions, preflight results, engine start, error, cleanup.
- **781 tests pass inside container**: `docker exec lyrashield-worker pnpm vitest run` → 781 passed, 0 failed (3.42s).
- **Rate limiting** verified: burst requests trigger 429, resets after window.

---

## §27 — Agent Action Layer (Sprint 3.5 + 7.6, 2026-07-06)

### Overview

Implemented the Agent Action Layer that exposes core LyraShield operations as typed Agent-Native actions with an approval gate for destructive operations. This enables AI agents (coding assistants, MCP clients) to invoke LyraShield actions programmatically while maintaining RBAC and human-in-the-loop approval for sensitive operations.

### Files created / modified

**Prisma schema + migration:**
- `packages/db/prisma/schema.prisma` — Added `ApprovalStatus` enum (PENDING/APPROVED/DENIED/EXPIRED) + `AgentApproval` model (id, workspaceId, actionName, inputHash, status, input JSON, requestedById, approvedById, approvedAt, deniedAt, expiresAt, result JSON, timestamps). Added `agentApprovals` relation on `Workspace`.
- `packages/db/prisma/migrations/20260706020000_agent_approval_layer/migration.sql` — Creates table, indexes (workspaceId, status, requestedById), FK to Workspace, + RLS policies (permissive + strict).
- `packages/db/src/scoping.ts` — Added `AgentApproval` to `WORKSPACE_SCOPED_MODELS` (now 18).
- `packages/db/src/extension.test.ts` — Updated workspace-scoped model count from 17 to 18.

**Types (`packages/types/src/index.ts`):**
- `ApprovalStatusSchema` — Zod enum for approval statuses.
- `ServiceTokenPayload` — userId, workspaceId, role, issuedAt, expiresAt.
- `AgentActionContext` — userId, workspaceId, role (passed to every action handler).
- `AgentActionResult` — success/data or error/code, needsApproval + approvalId for gated actions.
- `AgentActionDefinition<TInput, TOutput>` — name, description, inputSchema (Zod), permission, needsApproval?, handler, auditAction, auditResourceType.
- Input schemas: `ListTargetsInputSchema`, `RunScanInputSchema`, `GetScanStatusInputSchema`, `ListFindingsInputSchema`, `GetFindingInputSchema`, `ExplainFindingInputSchema`.
- `CreateApprovalInputSchema` — for creating approval requests.

**DB service (`packages/db/src/agent-approval-service.ts`):**
- `createApproval` — Creates a PENDING approval with 24h expiry, hashes input for dedup.
- `getApproval` — Fetches single approval by ID + workspaceId.
- `listApprovals` — Cursor-paginated list with optional status filter.
- `approveApproval` — Transitions PENDING → APPROVED, sets approvedById + approvedAt. Throws on not-found, not-pending, or expired.
- `denyApproval` — Transitions PENDING → DENIED, sets deniedAt. Same error cases.
- `saveApprovalResult` — Stores result JSON on approval after action execution.
- `expireStaleApprovals` — Bulk-updates PENDING approvals past expiresAt to EXPIRED.
- `hashInput` — SHA-256 hash of `{ actionName, input }` with recursive key sorting for deterministic canonicalization.
- `verifyInputHash` — Compares hash against expected.

**Auth permissions (`packages/auth/src/permissions.ts`):**
- Added `agent.view`, `agent.act`, `agent.approve` to PERMISSIONS.
- Role assignments: ADMIN/SECURITY_ADMIN get all 3; APPSEC_MANAGER/DEVELOPER get view+act; MEMBER/AUDITOR/VIEWER/EXTERNAL_PENTESTER get view only; BILLING_ADMIN gets none.

**Agent package (`apps/agent/`):**
- `package.json` — `@lyrashield/agent` workspace package, depends on auth/config/db/logger/types + bullmq + zod + vitest.
- `tsconfig.json` — Extends shared library config, `rootDir: ./src`, Node types.
- `src/service-token.ts` — `signServiceToken` (HMAC-SHA256, base64url, `lst.` prefix, 5-min TTL) + `verifyServiceToken` (validates prefix, signature, payload field types, expiry). Uses `BETTER_AUTH_SECRET` env var (min 32 chars). Payload validation checks `userId`, `workspaceId`, `role`, `issuedAt`, `expiresAt` are present and correctly typed.
- `src/registry.ts` — `ActionRegistry` class: `register(action)`, `list()`, `execute(name, input, context)`. Execute flow: validate input with Zod → check permission via `hasPermission` → check `needsApproval` → create approval if needed (return NEEDS_APPROVAL) → if `approvalId` provided, verify approval exists, is APPROVED, not expired, **actionName matches**, and **inputHash matches** via `verifyInputHash` → call handler → audit log (wrapped in separate try/catch so handler success isn't lost if audit fails) → return result. Error codes: UNKNOWN_ACTION, VALIDATION_ERROR, FORBIDDEN, NEEDS_APPROVAL, APPROVAL_NOT_FOUND, APPROVAL_NOT_APPROVED, APPROVAL_EXPIRED, APPROVAL_MISMATCH, APPROVAL_INPUT_MISMATCH, EXECUTION_ERROR.
- `src/queue.ts` — BullMQ queue helper (`enqueueScanJob`) mirroring `apps/web/src/lib/queue.ts`. Creates scan queue with Redis connection, 3 retries, exponential backoff. Used by `run-scan` action to enqueue scan jobs.
- `src/actions.ts` — 6 action definitions:
  1. `list-targets` — Lists targets in workspace (permission: `agent:view`). Response includes `projectId`.
  2. `run-scan` — Creates scan + **enqueues BullMQ job** via `queue.ts` (permission: `agent:act`, needsApproval when mode is DEEP). Validates target exists, **validates policyId exists** if provided, checks no active scan in progress. On enqueue failure, marks scan as FAILED with errorCategory QUEUE. Uses `triggerType: "agent"`.
  3. `get-scan-status` — Gets scan with events (permission: `agent:view`).
  4. `list-findings` — Cursor-paginated findings list (permission: `agent:view`). Response includes `createdAt`.
  5. `get-finding` — Single finding with evidence (permission: `agent:view`).
  6. `explain-finding` — Plain-language explanation via **static import** of `explainFinding` from `./plain-language-bridge` (permission: `agent:view`).
- `src/plain-language-bridge.ts` — Inlined `explainFinding` function (CWE explanations, generic severity explanations, category labels) to avoid cross-app tsconfig rootDir issues.
- `src/index.ts` — Exports + `createAgentRegistry()` factory. Exports `enqueueScanJob` from `./queue`.

**API routes (`apps/web/src/app/api/agent-approvals/`):**
- `route.ts` — GET: list approvals (paginated, status filter, `agent:view` permission).
- `[id]/approve/route.ts` — POST: approve a pending approval (`agent:approve` permission).
- `[id]/deny/route.ts` — POST: deny a pending approval (`agent:approve` permission).

**Tests (35 new):**
- `apps/agent/src/service-token.test.ts` — 8 tests: sign/verify roundtrip, wrong prefix, tampered token, expired token, malformed payload, missing/short secret, **valid signature but missing payload fields**.
- `apps/agent/src/registry.test.ts` — 11 tests: register/list, duplicate detection, unknown action, input validation, permission denial, successful execution, approval gate, handler errors, **audit log failure doesn't lose handler success**, **approval actionName mismatch**, **approval inputHash mismatch**.
- `packages/db/src/agent-approval-service.test.ts` — 5 tests: deterministic hash, different actions hash differently, different inputs hash differently, verify matching, verify mismatched.
- `packages/auth/src/agent-permissions.test.ts` — 11 tests: permission definitions, all role checks (ADMIN, SECURITY_ADMIN, APPSEC_MANAGER, DEVELOPER, MEMBER, VIEWER, AUDITOR, EXTERNAL_PENTESTER, BILLING_ADMIN), universal view check.

**Other updates:**
- `turbo.json` — Added `LYRASHIELD_AGENT_SERVICE_TOKEN` to globalEnv.
- `packages/db/src/rls.test.ts` — Added `AgentApproval` to RLS_TABLES (now 18).

### Deep code review fixes (7 fixes: 4 P1, 3 P2)

1. **(P1) Approval verification gap** (`registry.ts`) — When `approvalId` is provided, the registry now verifies `approval.actionName` matches the requested action and `verifyInputHash()` matches the input. Previously, an approved request for action A could be replayed for action B with different inputs.
2. **(P1) Audit log failure loses handler success** (`registry.ts`) — Wrapped `prisma.auditLog.create()` in its own `try/catch`. If the audit DB write fails, the handler's successful result is still returned. The error is logged but not propagated.
3. **(P1) Scan never enqueued** (`actions.ts` + new `queue.ts`) — The `run-scan` action called `createScan()` but never enqueued the BullMQ job. Added `enqueueScanJob()` with proper error handling (marks scan as FAILED if Redis unavailable). Added `bullmq` dependency.
4. **(P1) Service token payload not validated** (`service-token.ts`) — After JSON parse, payload fields (`userId`, `workspaceId`, `role`, `issuedAt`, `expiresAt`) are now type-checked. A token with valid signature but missing fields is rejected.
5. **(P2) Dynamic import → static import** (`actions.ts`) — Changed `explainFinding` from `await import()` to a top-level static import.
6. **(P2) Policy validation + response fields** (`actions.ts`) — `run-scan` now validates `policyId` exists. Added `projectId` to `list-targets` response and `createdAt` to `list-findings` response.
7. **(P2) Deny function documentation** (`agent-approval-service.ts`) — Added comment clarifying `approvedById` stores the decision-maker for both approve and deny.

### Test count

**781 tests (62 files), all green.** Up from 758 tests (60 files) — 23 new tests from deep code review.

---

## §28 — Reliability, Tenant-Safety, and UX Hardening (2026-07-10)

Focused remediation after a fresh full-repository review.

### Security and tenant isolation

- **Agent workspace binding** (`apps/agent/src/registry.ts`) rejects an input `workspaceId` that differs from the authenticated service-token context.
- **Report ownership enforcement** (`apps/web/src/app/api/reports/route.ts`, `packages/db/src/report-service.ts`) uses workspace-scoped scan/finding queries, preventing cross-workspace scan IDs from being attached or exposed.
- **URL scanner SSRF defense-in-depth** (`apps/worker/src/engine/scanners/url-scanner.ts`) resolves the hostname before requesting it, rejects private/reserved addresses, manually revalidates each redirect target, and disables automatic redirects. A transport-level egress proxy with pinned DNS remains the durable deployment control.

### Correctness and reliability

- **Server-owned workspace selection** (`apps/web/src/app/api/workspaces/active/route.ts`, `apps/web/src/lib/cache.ts`, `apps/web/src/components/sidebar.tsx`) stores a validated selection in a secure HttpOnly cookie and only selects a current membership.
- **Atomic scheduling and scan admission** (`packages/db/src/schedule-service.ts`, `packages/db/src/scan-service.ts`) prevent duplicate scheduler enqueueing and serialize scans per target.
- **Cancellation/retry correctness** (`packages/db/src/scan-transitions.ts`, `apps/worker/src/jobs/run-scan.job.ts`, `apps/worker/src/engine/runner.ts`) guards concurrent updates, re-enters valid retry states, stops cancelled jobs cleanly, and escalates process shutdown only when needed.
- **Notification fault isolation** (`apps/worker/src/jobs/run-scan.job.ts`) logs notification delivery failures without reversing an already-finalized scan or creating a spurious retry.
- **Monorepo SCA discovery** (`apps/worker/src/engine/scanners/sca-scanner.ts`) finds nested dependency manifests while ignoring build/dependency directories.

### UX

- Terminal scan polling refreshes findings so scan-detail results do not remain stale.
- Settings labels now accurately describe request-scoped filtering and audit logging rather than implying unavailable runtime controls.

### Verification

- Regression coverage covers workspace mismatch rejection, report ownership, workspace selection, schedule claims, scan lifecycle concurrency/retries, subprocess cancellation, notification failure isolation, DNS/redirect validation, and nested manifests.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass: **597 source tests in 47 test files**. Generated `dist` artifacts are excluded so test results are not double-counted in Docker.
- `pnpm db:generate` passes. The migration-diff remained CI-gated during this pass; Docker was subsequently brought online and reverified in §29.

---

## §29 — Engine Repository Bootstrap and Docker Integration (2026-07-10)

- Restored the sibling `lyrashield-engine` toolchain with `uv`, reconciled the frozen lockfile from the stale `strix-agent` package name to `lyrashield-engine` 1.0.4, and added a focused CLI version regression test.
- Fixed `lyrashield --version`, Pydantic 2.11 configuration persistence deprecation, a shared mutable Docker mount default, and the missing-configuration startup order. The CLI now validates model configuration before Docker/sandbox setup.
- Added an engine `.dockerignore` so local virtual environments and generated output are excluded from Docker build contexts.
- Added a dedicated `worker` Docker target. Compose supplies the sibling engine as a named build context, installs its frozen production environment, exposes the CLI on `PATH`, and mounts the Docker socket in the explicitly local/dev stack for sandbox launches.
- Aligned the worker exit-code contract with the real CLI: engine exit `1` is a runtime/configuration failure, while exit `2` means a completed scan with findings. This prevents missing engine configuration from being recorded as a successful scan.

### Verification

- Engine: **62 tests pass** with Pydantic deprecations treated as errors; Ruff lint and formatting pass; headless mypy passes across 58 source files; Bandit reports zero findings.
- Worker image build runs `lyrashield --version` as a build-time smoke gate and reports **1.0.4**.
- Running worker reports ready, reaches the Docker daemon, and passes the app's **597 tests across 47 files**.
- Missing `LYRASHIELD_LLM` exits cleanly before sandbox setup. A paid/full scan was not started because no LLM configuration is present.
- Known engine debt: full TUI mypy currently reports 69 Textual/Pygments typing errors, and repository-wide Pyright reports broad pre-existing unknown-type debt. These do not block the non-interactive worker path but should be handled as a separate typing-hardening batch.

---

## §30 — Thin-Fork Automation and Current Release Gate (2026-07-11)

### Upstream boundary and compatibility contract

- The sibling engine records upstream baseline `7b639505fecf20a2d9e356f96bd91470aa828182`; the local thin-fork branch includes the adapter and its PR-only sync automation at `909493f`.
- `lyrashield` is an adapter entry point, not a reimplementation of upstream: it maps `LYRASHIELD_LLM`, image, runtime, local-copy, reasoning, and telemetry variables to their `STRIX_*` equivalents only when the upstream value is absent. An explicitly supplied `STRIX_*` value wins; `STRIX_TELEMETRY` defaults to `0`.
- The worker preserves upstream compatibility by discovering the newest usable artifact directory in both `strix_runs` and `lyrashield_runs`, accepting either `run.json` or `vulnerabilities.json`. Its lifecycle contract remains: `0` = completed without findings, `2` = completed with findings, other/nonzero runtime failures = failed scan.

### Reviewed sync automation

- `.github/workflows/upstream-sync.yml` runs weekly on Monday at 03:23 UTC and on manual dispatch. It runs `scripts/check-upstream.sh`, rebases only after the recorded base is proven ancestral, verifies the fork, and opens `automation/upstream-<short-sha>` for review.
- It contains no auto-merge, merge queue, force-push, or conflict resolver. The normal no-change check returned `needs_sync=false`; an isolated divergent-upstream test returned exit `20` before rebase.
- This local fork has only the `upstream` remote, not a LyraShield-controlled writable `origin`. The workflow commit is local only: no remote was created, no workflow was dispatched, and no PR was opened.

### Verification evidence and remaining release blockers

- Engine verification passed: frozen sync, Ruff, formatting, **155 pytest tests**, headless mypy across **61 source files**, and Bandit.
- Application verification passed: `pnpm lint`, `pnpm typecheck`, `pnpm test` (**600 tests / 47 files**), `pnpm build`, and `git diff --check`.
- The current `docker compose build worker` release gate did **not** complete. Its frozen install and Prisma generation passed, but Docker's root `pnpm build` included the unrelated uncommitted `apps/marketing` workspace and failed when its Cloudflare adapter tried to spawn the absent Linux ARM `workerd` binary. Therefore no current worker image digest, `lyrashield --version` container smoke, missing-model container run, or sandbox launch is asserted here. The local/dev Compose socket mount is a development-only sandbox mechanism; production deployment still requires a separately pinned sandbox image digest.
- Neither `LYRASHIELD_LLM` nor `LLM_API_KEY` is configured in the environment or `.env`. No external, public, paid, or otherwise substitute target was used. The controlled authorized scan, persisted findings, and rendered scan-detail proof remain blocked only by missing LLM configuration, after a successful image gate is available.
