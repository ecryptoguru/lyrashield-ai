# LyraShield — Codebase Guide for AI Agents

> **Purpose**: This document gives AI agents (Claude, GPT, Copilot, etc.) a complete mental model of the LyraShield codebase so they can navigate, modify, and extend it effectively.

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
| Icons | lucide-react | 0.469.x |
| Monorepo | Turborepo + pnpm workspaces | 2.10.x / 11.6.x |
| Worker | tsx watch (stub mode) | — |
| Job queue | BullMQ (planned Sprint 4) | 5.78.x |

**Key version notes**:
- TypeScript 6: `types: ["node"]` required in tsconfig, `baseUrl` is deprecated
- Prisma 7: uses `prisma.config.ts` with dotenv, requires `PrismaPg` driver adapter in client constructor (no datasource URL in schema)
- Zod 4: use `z.url()` instead of `z.string().url()`, `z.email()` instead of `z.string().email()`
- TailwindCSS 4: CSS-first config via `@theme` in `globals.css`, no `tailwind.config.js`

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
│   │   │   │   │   │   │   ├── page.tsx          # Server component
│   │   │   │   │   │   │   └── projects-client.tsx
│   │   │   │   │   │   ├── targets/              # Target list + create + detail
│   │   │   │   │   │   │   ├── page.tsx          # Server component
│   │   │   │   │   │   │   ├── targets-client.tsx
│   │   │   │   │   │   │   └── [id]/page.tsx     # Target detail page
│   │   │   │   │   │   └── team/                 # Team members + invites
│   │   │   │   │   │       ├── page.tsx          # Server component
│   │   │   │   │   │       └── team-client.tsx
│   │   │   │   │   ├── layout.tsx                # Dashboard layout (auth guard + sidebar)
│   │   │   │   │   └── loading.tsx
│   │   │   │   ├── api/                          # REST API routes
│   │   │   │   │   ├── auth/[...all]/route.ts    # Better Auth handler
│   │   │   │   │   ├── projects/route.ts         # POST + GET projects
│   │   │   │   │   ├── targets/route.ts          # POST + GET targets (with SSRF)
│   │   │   │   │   ├── team/route.ts             # POST invite + GET members
│   │   │   │   │   └── workspaces/route.ts       # POST create + GET list workspaces
│   │   │   │   ├── sign-in/page.tsx              # Sign-in page (email + GitHub OAuth)
│   │   │   │   ├── sign-up/page.tsx              # Sign-up page
│   │   │   │   ├── page.tsx                      # Marketing landing page
│   │   │   │   ├── layout.tsx                    # Root layout (Inter font)
│   │   │   │   ├── globals.css                   # Tailwind theme + global styles
│   │   │   │   ├── not-found.tsx
│   │   │   │   └── icon.svg
│   │   │   └── components/
│   │   │       ├── sidebar.tsx                   # Dashboard sidebar nav
│   │   │       └── workspace-switcher.tsx        # Workspace dropdown switcher
│   │   ├── next.config.ts                        # transpilePackages + serverExternalPackages
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
│   │       ├── index.ts          # Re-exports models + prisma client
│   │       └── generated/prisma/ # Prisma generated client (gitignored)
│   ├── types/                                    # Shared Zod schemas + TS types
│   │   └── src/index.ts          # All schema definitions + ApiResponse types
│   ├── ui/                                       # Shared UI components (shadcn/ui base)
│   ├── config/                                   # Shared tsconfig presets
│   ├── logger/                                   # Structured JSON logger
│   │   └── src/index.ts
│   └── integrations/                             # External integrations (planned)
├── docker-compose.yml                            # PostgreSQL 16 + Redis 7
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
3. Check workspace membership via `prisma.workspaceMember.findUnique()` — return 403 if not active
4. Check role-specific permissions if needed
5. Perform the operation
6. Write audit log via `prisma.auditLog.create()`
7. Return `{ success: true, data: ... }` or `{ success: false, error: { code, message } }`

### 4.5 Server/Client Component Split

- **Server components** (`page.tsx`): Fetch session, workspace membership, and data via Prisma. Pass data as props to client components.
- **Client components** (`*-client.tsx`): Handle form state, fetch calls to API routes, interactive UI. Use `useState` + `useEffect` for data fetching.
- **Dashboard layout** (`(dashboard)/layout.tsx`): Auth guard — redirects to `/sign-in` if no session. Fetches all workspace memberships for sidebar.

### 4.6 Prisma 7 Configuration

- **Config file**: `packages/db/prisma.config.ts` uses `defineConfig()` with dotenv to load `.env` from repo root
- **Schema**: `packages/db/prisma/schema.prisma` — generator outputs to `../src/generated/prisma` (gitignored)
- **Client**: `packages/db/src/client.ts` — singleton with `PrismaPg` adapter, cached on `globalThis` for dev hot reload
- **No datasource URL in schema** — only `provider = "postgresql"`. URL comes from `prisma.config.ts`

### 4.7 SSRF Protection

`apps/web/src/app/api/targets/route.ts` contains an SSRF blocklist that validates URL target hostnames:

**Blocked ranges**:
- `127.` prefix (full 127.0.0.0/8 loopback)
- `0.0.0.0` (reserved)
- `10.` prefix (private)
- `192.168.` prefix (private)
- `169.254.` prefix (link-local / cloud metadata)
- `172.16.` through `172.31.` prefixes (private)
- `::1`, `::ffff:`, `fc00:`, `fe80:`, `fd00:` (IPv6)
- `localhost`, `metadata.google.internal`

**Additional checks**: Rejects hostnames with trailing dot (bypass prevention). Only `http://` and `https://` schemes allowed (enforced by `z.url()` in Zod schema).

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
- **Integration** — workspaceId, type, config
- **UsageRecord** — workspaceId, metric, value, period
- **AuditLog** — workspaceId, actorUserId, action, resourceType, resourceId, metadata (JSON)
- **Invitation** — workspaceId, email, token (unique), role, status (pending/accepted/expired), expiresAt, invitedById

---

## 6. Environment Variables

Required for local development (see `.env.example`):

```bash
# Database
DATABASE_URL="postgresql://lyrashield:lyrashield@localhost:5432/lyrashield?schema=public"

# Redis
REDIS_URL="redis://localhost:6379"

# Better Auth
BETTER_AUTH_SECRET="replace-with-a-strong-secret-key-min-32-chars"
BETTER_AUTH_URL="http://localhost:3000"

# GitHub OAuth
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""

# Google OAuth (optional)
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""

# App
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

Additional env vars for later sprints: GitHub App, S3/R2 evidence storage, Brevo email, Polar/Razorpay billing, Sentry monitoring, LyraShield engine (`LYRASHIELD_LLM`, `LLM_API_KEY`, `LYRASHIELD_IMAGE`, `LYRASHIELD_ENGINE_PATH`, `LYRASHIELD_TELEMETRY=false`).

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

### Sprint 2.5: Onboarding Flow — Not Started
### Sprint 3: Scan Queue — Not Started
### Sprint 4: LyraShield Scan Engine — Not Started

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

**API response format**:
```json
// Success
{ "success": true, "data": ... }

// Error
{ "success": false, "error": { "code": "ERROR_CODE", "message": "Human-readable message" } }
```

**Common error codes**: `UNAUTHORIZED` (401), `FORBIDDEN` (403), `VALIDATION_ERROR` (400), `INVALID_JSON` (400), `MISSING_PARAM` (400), `SSRF_BLOCKED` (400), `ALREADY_INVITED` (409), `SLUG_TAKEN` (409), `PROJECT_NOT_FOUND` (404), `INTERNAL_ERROR` (500)

---

## 10. UI Components

### Sidebar (`apps/web/src/components/sidebar.tsx`)
- Navigation with icons: Dashboard, Projects, Targets, Scans (Radar icon), Findings, Fixes, Reports, Team, Settings
- Workspace switcher embedded at top
- User info + sign-out button at bottom
- Active route highlighting via `usePathname`
- Sign-out calls `signOut()` from `@lyrashield/auth`

### Workspace Switcher (`apps/web/src/components/workspace-switcher.tsx`)
- Dropdown with click-outside and Escape key to close
- ARIA attributes: `aria-expanded`, `aria-haspopup`, `role="listbox"`
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

**No middleware.ts** — auth protection is handled in the `(dashboard)/layout.tsx` server component via `getSession()` + `redirect()`.

---

## 14. Coding Conventions

- **Imports**: Use `@lyrashield/*` workspace package imports, not relative paths across packages
- **Server vs client**: `"use client"` directive at top of client components. Server components have no directive
- **API routes**: Always validate input with Zod, check auth + workspace membership, write audit logs
- **Error handling**: API routes return `{ success: false, error: { code, message } }` with appropriate HTTP status
- **Database queries**: Always scope by `workspaceId` to prevent cross-tenant data access
- **Soft deletes**: Targets use `deletedAt` field (filter with `deletedAt: null`)
- **Icons**: Use `lucide-react` icons. Each nav item should have a unique icon
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

---

## 16. File Quick Reference

| File | Purpose |
|------|---------|
| `apps/web/src/app/(dashboard)/layout.tsx` | Auth guard + sidebar shell |
| `apps/web/src/app/(dashboard)/dashboard/page.tsx` | Main dashboard with aggregate stats |
| `apps/web/src/app/(dashboard)/dashboard/projects/projects-client.tsx` | Project list + create form |
| `apps/web/src/app/(dashboard)/dashboard/targets/targets-client.tsx` | Target list + repo/URL create forms |
| `apps/web/src/app/(dashboard)/dashboard/targets/[id]/page.tsx` | Target detail with scans |
| `apps/web/src/app/(dashboard)/dashboard/team/team-client.tsx` | Team members + invite form |
| `apps/web/src/app/api/projects/route.ts` | POST + GET projects API |
| `apps/web/src/app/api/targets/route.ts` | POST + GET targets API (with SSRF) |
| `apps/web/src/app/api/team/route.ts` | POST invite + GET members API |
| `apps/web/src/app/api/workspaces/route.ts` | POST create + GET list workspaces API |
| `apps/web/src/components/sidebar.tsx` | Dashboard sidebar navigation |
| `apps/web/src/components/workspace-switcher.tsx` | Workspace dropdown switcher |
| `packages/auth/src/auth.ts` | Better Auth config |
| `packages/auth/src/session.ts` | Session + workspace access helpers |
| `packages/auth/src/permissions.ts` | RBAC role/permission matrix |
| `packages/auth/src/client.ts` | Better Auth client (client-safe) |
| `packages/auth/src/index.ts` | Client-safe exports |
| `packages/auth/src/server.ts` | Server-only exports |
| `packages/db/prisma/schema.prisma` | Full database schema |
| `packages/db/prisma.config.ts` | Prisma 7 config |
| `packages/db/src/client.ts` | PrismaClient singleton with PrismaPg |
| `packages/db/src/index.ts` | DB package exports |
| `packages/types/src/index.ts` | All Zod schemas + TS types |
| `packages/logger/src/index.ts` | Structured JSON logger |
| `apps/web/next.config.ts` | Next.js config (transpile + external packages) |
| `docker-compose.yml` | Postgres 16 + Redis 7 |
| `turbo.json` | Turborepo task definitions |
| `pnpm-workspace.yaml` | Workspace + build allowlist |
| `.env.example` | All environment variables |
| `PRD.md` | Full PRD + sprint backlog |
