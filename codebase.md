# LyraShield — Codebase Guide for AI Agents

> **Purpose**: This document gives AI agents (Claude, GPT, Copilot, etc.) a complete mental model of the codebase so they can navigate, modify, and extend it effectively.
>
> **New agent? Start with [`AGENTS.md`](./AGENTS.md)** (repo root) for current state, the next tasks, and the landmines — then use this file as the deep code map and `PRD.md` PART B §B13 as the backlog source of truth.
>
> **⚠️ 2026-07-05:** The GitHub repo is now **`ecryptoguru/lyrasec-ai`** (renamed from `lyrashieldai`). The product name is migrating LyraShield → **LyraSec AI**, but the in-code package scopes (`@lyrashield/*`) and engine env vars (`LYRASHIELD_*`) are intentionally **not** renamed yet (trademark clearance open) — keep using them in code. See **§17 (2026-07-04 Audit — Batch 1)**, **§18 (2026-07-05 UI/UX Premium Upgrade + Deep Code Review)**, and **§19 (2026-07-05 Batch 2 Remainder + Batch 3 Design Contracts + RLS + Deep Code Review)** at the end for the latest merged changes; where they conflict with older sections below, §17/§18/§19 win.

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
│   │   │   ├── rate-limit.ts          # Rate limiting middleware (Upstash Redis)
│   │   │   └── rate-limit.test.ts     # Rate limit tests (8 tests)
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
- **Rate limiting**: `middleware.ts` — auth endpoints 5/min per IP, general API 30/min per IP; Upstash Redis in prod, in-memory fallback in dev
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

### Sprint 4: Scan Orchestrator and Queue — Not Started
### Sprint 5: LyraShield Scan Engine MVP — Not Started

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

**Verification**: lint ✅ (0 errors), typecheck ✅, tests ✅ (113/113), build ✅

### Engine Repo (lyrashield-engine) — Forked & Rebranded

The engine repo has been forked from usestrix/strix, fully rebranded to LyraShield, and is ready for upgrades. See [Engine Repo Status](#engine-repo-status) in Section 1 for full details.

**Completed**:
- Fork from usestrix/strix with upstream remote configured
- Full rebrand: zero "Strix" references remaining, CLI binary renamed to `lyrashield`
- Telemetry disabled (PostHog + Scarf off by default, `LYRASHIELD_TELEMETRY=false`)
- Upgrade roadmap documented in `UPGRADES.md`

**Pending** (mapped to sprints):
- Sprint 5: Structured JSON findings, exit codes, event streaming, policy hooks
- Sprint 6: Dedupe keys, evidence packaging, CVSS auto-scoring
- Sprint 7: Structured patch output with safety score
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

**Middleware** (`apps/web/src/middleware.ts`) — Rate limiting on API routes:
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
| `apps/web/src/middleware.ts` | Rate limiting middleware (auth 5/min, API 30/min) |
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
- **Web security headers (`apps/web/next.config.ts`)** — `headers()` adds HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy; `poweredByHeader:false`, `reactStrictMode:true`, `images.remotePatterns` (GitHub/Google avatars). (Full nonce-based **CSP** still deferred.)
- **Logger (`packages/logger`)** — now **redacts** sensitive keys (password/secret/token/authorization/apikey/privatekey/cookie/credential/vaultref/verificationurl/otp), captures `Error`, breaks circular refs, truncates oversized output. Use it freely; still never log raw secrets deliberately.
- **GitHub integration (`packages/integrations/src/github.ts`)** — installation-token **caching** (per `installationId`, using `expires_at`), retry/backoff (`githubFetch`, honors `Retry-After`), paginated `getAppInstallations`, `crypto.timingSafeEqual`.
- **Auth (`packages/auth/src/auth.ts`)** — `trustedOrigins` = `BETTER_AUTH_URL` + `ADDITIONAL_TRUSTED_ORIGINS` (comma-separated).
- **Dependabot** (`.github/dependabot.yml`) — weekly npm + github-actions; majors excluded from auto-PRs.

**🔴 KNOWN ISSUE — Prisma migration drift (latent P0 on deploy):** only 2 migrations exist and `schema.prisma` is far ahead (tables `ApiKey`/`OnboardingState`/`Retest` + many columns/indexes/constraints were applied via `db push`, never migrated). `prisma migrate deploy` on a **fresh** DB (CI/prod) yields a DB that mismatches the generated client. **Use `prisma db push` for local dev until a reconciling migration is generated** (`prisma migrate dev`) and a CI drift-check is added. See PRD §B13.7 R-C/R-F.

Remaining audit backlog (Batches 2–4, plus the round-2 Codex items: migration-drift reconciliation, CI hardening, supply-chain pinning + `eslint-plugin-security`, CSP) is in **PRD PART B §B13.5 / §B13.6 / §B13.7** — the PRD is the single source of truth.
