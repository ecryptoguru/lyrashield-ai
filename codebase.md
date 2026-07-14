# LyraShield AI — Codebase Guide

> **Purpose:** Maintained implementation map for the canonical `lyrashieldai` repository. `AGENTS.md` owns the current handoff/rules; `PRD.md` Part C owns product status and release gates. Running code and schema override documentation.
>
> **New agent? Start with [`AGENTS.md`](./AGENTS.md)** (repo root) for current state, the execution queue, and the landmines — then use this file as the deep code map and `PRD.md` Part C as the backlog and release-readiness source of truth.
>
> **Current baseline — 2026-07-14:** 4 apps, 10 shared packages (including `packages/score`), 22 web page files, 40 API route files, 35 Prisma models, 14 enums, 16 migrations, 18 RLS-protected workspace tables, and passing lint, typecheck, test, E2E, production build, formatting, Docker Compose validation, migration status, production dependency audit, and diff checks locally (738 Vitest tests in 72 files; 2 Playwright Chromium tests). Sections 17–37 are dated implementation history; their older counts are checkpoints, not the current gate.

---

## 1. System Overview

LyraShield AI is a multi-tenant, agent-native application-security platform for GitHub repositories and deployed URLs.

**Core product loop**: `Target → Scan → Verified Finding → Fix → Retest → Report`

**Architecture boundary**:

- **This monorepo** (TypeScript/Astro): product UI and APIs, auth/tenancy, scan orchestration, deterministic scanners, findings, remediation, reports, schedules/notifications, agent actions, MCP, and marketing.
- **`lyrashield-engine`** (separate Python repo): thin compatibility fork over upstream Strix. The worker calls the `lyrashield` adapter as a subprocess; no engine internals are imported.
- **Not yet implemented:** billing/usage enforcement and the user-facing API-key lifecycle. Controlled-scan and production-infrastructure proof remain release gates. See `PRD.md` Part C.

### Engine Repo Status

The canonical engine repo is `ecryptoguru/lyrashield-engine`. It is a thin adapter fork, not a repository-wide rebrand:

- **Repo:** `ecryptoguru/lyrashield-engine`
- **Upstream remote**: `https://github.com/usestrix/strix.git`
- **Recorded upstream baseline:** `7b639505fecf20a2d9e356f96bd91470aa828182`
- **Adapter version:** `1.0.4.post1`
- **Compatibility:** maps `LYRASHIELD_*` only when the corresponding `STRIX_*` value is unset; explicit upstream values win; telemetry defaults to `0`
- **Model config:** the engine accepts one resolved `LYRASHIELD_LLM`/`STRIX_LLM` per subprocess plus `LLM_API_KEY`/`LLM_API_BASE`/`LLM_API_VERSION` and Azure aliases. Before spawning it, the TypeScript worker resolves `LYRASHIELD_LUNA_LLM` for Safe/Quick/Standard or `LYRASHIELD_TERRA_LLM` for Deep/Custom, falling back to `LYRASHIELD_LLM`. `strix/config/models.py` mirrors credentials/endpoints into the LiteLLM variables expected by `azure/`, `azure_ai/`, and `litellm/` providers.
- **Artifacts:** worker accepts `strix_runs` and legacy `lyrashield_runs`, with `run.json` or `vulnerabilities.json`
- **Sync model:** ancestry-checked, review-only PRs; no auto-merge, force-push, or conflict resolution
- **Verification:** 155 tests, Ruff, formatting, headless mypy, and Bandit

### Engine Boundary

The engine-bearing worker image builds from the sibling canonical repo through a named Docker build context. `lyrashield --version` is a build gate. Missing model configuration exits before sandbox image setup.

Exit-code contract:

- `0`: completed without findings
- `2`: completed with findings
- other nonzero exits: runtime/configuration failure

One local Safe scan against an approved public repository has completed through the Docker sandbox with Luna/medium routing, zero findings, and a retained post-run budget-overage warning. It is target-scoped only. Production still requires approved target/environment proof, inspected image provenance, retained evidence artifacts where applicable, and transport-level egress enforcement.

### Naming Boundary

Public copy uses **LyraShield AI**. Internal package scopes (`@lyrashield/*`), environment variables (`LYRASHIELD_*`), database/container names, and the engine CLI remain unchanged pending founder-approved migration. Do not mechanically rename them.

---

## 2. Tech Stack

| Layer                   | Technology                       | Version                                              |
| ----------------------- | -------------------------------- | ---------------------------------------------------- |
| Web framework           | Next.js (App Router, Turbopack)  | 16.2.x                                               |
| Language                | TypeScript                       | 6.0.x                                                |
| Runtime                 | React                            | 19.x                                                 |
| ORM                     | Prisma (with @prisma/adapter-pg) | 7.8.x                                                |
| Database                | PostgreSQL                       | 16 (Docker)                                          |
| Cache/Queue             | Redis                            | 7 (Docker)                                           |
| Auth                    | Better Auth                      | 1.6.x                                                |
| Validation              | Zod                              | 4.x                                                  |
| Styling                 | TailwindCSS (CSS-first config)   | 4.3.x                                                |
| Component variants      | class-variance-authority (cva)   | 0.7.x                                                |
| Icons                   | lucide-react                     | 1.23.x                                               |
| Monorepo                | Turborepo + pnpm workspaces      | 2.10.x / 11.6.x                                      |
| Testing                 | Vitest + Playwright              | 689 unit/integration tests + 2 Chromium E2E tests    |
| Worker                  | Node.js/TypeScript + tsx         | BullMQ jobs, schedules, engine/scanner orchestration |
| Job queue               | BullMQ                           | 5.78.x                                               |
| Agent service           | Node.js/TypeScript               | Signed tokens, registry, actions, approval gate      |
| MCP                     | JSON-RPC over stdio              | API-backed tools + prompt-injection guard            |
| Scan engine             | Python thin fork                 | Adapter 1.0.4.post1 over recorded upstream baseline  |
| Marketing site          | Astro 7 + @astrojs/cloudflare    | Server output on Cloudflare Workers                  |
| Marketing storage       | Cloudflare D1                    | Waitlist + fallback-rate-limit migrations            |
| Marketing rate limiting | Cloudflare Rate Limits           | WAITLIST_RL binding for waitlist API                 |
| Marketing analytics     | PostHog                          | posthog-js client-side capture                       |

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

```txt
lyrashield/
├── apps/
│   ├── web/                    # Next.js dashboard, public shared reports, REST routes
│   │   └── src/
│   │       ├── app/
│   │       │   ├── (dashboard)/dashboard/
│   │       │   │   ├── projects/ targets/ scans/ findings/ fixes/
│   │       │   │   ├── reports/ notifications/ schedules/
│   │       │   │   ├── launch-readiness/ integrations/ team/ settings/
│   │       │   │   └── page.tsx
│   │       │   ├── api/       # 39 protected/public-data route files; see §9
│   │       │   ├── (public)/  # Scorecard pages plus OG image and SVG badge routes
│   │       │   ├── onboarding/
│   │       │   ├── reports/shared/[id]/
│   │       │   ├── sign-in/ and sign-up/
│   │       │   ├── globals.css
│   │       │   └── layout.tsx
│   │       ├── components/    # Sidebar, workspace switcher
│   │       ├── lib/           # API helpers, caches, rate limits, GitHub state
│   │       └── proxy.ts       # Nonce CSP + rate limiting
│   ├── worker/
│   │   └── src/
│   │       ├── engine/
│   │       │   ├── runner.ts, command-builder.ts, output-parser.ts
│   │       │   ├── normalizer.ts, verifier.ts, finding-persister.ts, evidence-storage.ts
│   │       │   ├── scanner-orchestrator.ts, sarif-generator.ts
│   │       │   └── scanners/  # SCA, secrets, URL
│   │       ├── jobs/           # Preflight and run-scan jobs
│   │       ├── queue.ts
│   │       ├── schedules.ts
│   │       ├── notifications.ts
│   │       └── index.ts
│   ├── agent/
│   │   └── src/               # Registry, six actions, queue (shared wrapper), service tokens
│   └── marketing/
│       ├── src/
│       │   ├── pages/         # Landing, blog, SEO routes, waitlist API
│       │   ├── components/
│       │   ├── layouts/
│       │   ├── content/
│       │   └── styles/
│       ├── migrations/        # Cloudflare D1 waitlist migrations
│       ├── astro.config.mjs
│       └── wrangler.jsonc
├── packages/
│   ├── auth/                  # Better Auth, sessions, permissions, role ceilings
│   ├── config/                # Zod environment contract
│   ├── db/
│   │   ├── prisma/
│   │   │   ├── schema.prisma # 35 models, 14 enums
│   │   │   └── migrations/   # 12 committed PostgreSQL migrations
│   │   └── src/              # Prisma client (with audit-hash extension), RLS/scoping, domain services
│   ├── integrations/          # GitHub, notification delivery, Redis, and shared queue helpers
│   ├── logger/                # Structured redacting logger
│   ├── mcp/                   # Tools, server, stdio transport, injection guard
│   ├── security/              # Shared SSRF validation and safeFetch
│   ├── types/                 # Shared Zod schemas, DTOs, action/scan types
│   └── ui/                    # Shared accessible components and variants
├── .github/
│   ├── workflows/             # CI and LyraShield diff gate
│   └── dependabot.yml
├── docs/deployment/           # Local and production runbooks
├── AGENTS.md                  # Current handoff, queue, rules, landmines
├── PRD.md                     # Product specification; Part C is current status
├── codebase.md                # This implementation map
├── product.md                 # Positioning and founder decisions
├── engine-NOTICE.md           # Engine notices and modification record
├── Dockerfile                 # Web and engine-bearing worker targets
├── docker-compose.yml         # Local Postgres, Redis, migrate, web, worker
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

Generated directories such as `node_modules/`, `.next/`, `dist/`, `.astro/`, `.wrangler/`, Prisma generated client output, and `*.tsbuildinfo` are not source-of-truth surfaces.

---

## 4. Key Architectural Patterns

### 4.1 Auth Package Split

The auth package has a **client-safe / server-only split** to avoid importing `next/headers` or Prisma into client bundles:

- **`@lyrashield/auth`** (client-safe): `authClient`, `signIn`, `signOut`, `signUp`, `getClientSession`, `useSession`, `PERMISSIONS`, `hasPermission`, `hasMinimumRole`
- **`@lyrashield/auth/server`** (server-only): `auth`, `getSession`, `requireAuth`, `getWorkspaceMembership`, `requireWorkspaceAccess`, `requirePermission`

**Import rule**: Client components import from `@lyrashield/auth`. Server components and API routes import from `@lyrashield/auth/server`.

**Session access in client components**: prefer `getClientSession()` (a Promise-based `authClient.getSession()` wrapper) for one-off session checks. The `useSession()` hook is a nanostore atom that can produce a non-callable type error in the current `better-auth` client; avoid calling it as a function in React components.

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
6. Write audit log via `prisma.auditLog.create()` — the Prisma client extension computes `prevHash` and `hash` automatically
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
- **Client**: `packages/db/src/client.ts` — singleton with `PrismaPg` adapter and an audit-hash extension, cached on `globalThis` for dev hot reload
- **No datasource URL in schema** — only `provider = "postgresql"`. URL comes from `prisma.config.ts`

### 4.7 SSRF Protection

The SSRF logic lives in **`packages/security`**. `apps/web/src/lib/ssrf.ts` re-exports `checkScanUrlSafe` for compatibility, and the URL-target API plus worker URL scanner share the same implementation. It does **DNS-resolution-aware** validation, not string-prefix matching:

- Only `http(s)` schemes; rejects empty host and trailing-dot hostnames; blocks `localhost`/`*.localhost`/metadata hostnames.
- **Resolves the hostname and validates every resolved A/AAAA address** against the blocklist (so a public domain that resolves to an internal IP is rejected).
- Full IPv4 CIDR coverage: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, `169.254/16` (link-local + cloud metadata), `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, multicast, reserved. Canonicalizes decimal/octal/hex IPv4.
- IPv6: strips brackets + zone id; handles IPv4-mapped (`::ffff:`), IPv4-compat, NAT64 (`64:ff9b::/96`), ULA (`fc00::/7`), link-local (`fe80::/10`), multicast; fail-closed on unparseable v6.
- Injectable resolver for tests (`ssrf.test.ts`).

The worker uses `safeFetch` to re-resolve and validate every redirect hop before fetching. **Remaining deployment control:** application validation does not pin the transport connection to the validated address, so untrusted multi-tenant scans still require a transport-level egress proxy or equivalent DNS-pinned enforcement. See `PRD.md` Part C.

---

## 5. Database and Persistence

The Prisma schema is `packages/db/prisma/schema.prisma` (35 models, 14 enums). Prisma 7 reads connection configuration from `packages/db/prisma.config.ts`; generated client output lives under `packages/db/src/generated/prisma` and is gitignored.

### Model Groups

**Better Auth managed:** `User`, `Session`, `Account`, `Verification`.

**Workspace/access:** `Workspace`, `WorkspaceMember`, `Invitation`, `ApiKey`, `AgentApproval`, `OnboardingState`.

**Projects, targets, policy, integrations:** `Project`, `Target`, `CredentialSet`, `Policy`, `Integration`, `WebhookEvent`.

**Scan/remediation/output:** `Scan`, `ScanEvent`, `Finding`, `Evidence`, `FixProposal`, `PullRequest`, `Ticket`, `Retest`, `Report`, `Notification`, `Schedule`, `UsageRecord`, `AuditLog`, `BillingAccount`.

**Score/growth:** `ScoreSnapshot`, `ReferralCode`, `ReferralAttribution`, `ScorecardShare`, `ScorecardEvent`.

`ApiKey` and `BillingAccount` are schema foundations; user-facing API-key management and billing/usage enforcement are not implemented.

### Isolation and Deletion

- `packages/db/src/scoping.ts` owns the AsyncLocalStorage workspace context and the exact model allowlists for automatic workspace and soft-delete filters.
- `WorkspaceMember` is excluded from automatic workspace scoping so the workspace switcher can query memberships. `OnboardingState` is user-scoped. Never add models to an allowlist unless the matching schema column exists.
- `withWorkspaceRLS(workspaceId, fn)` in `packages/db/src/rls.ts` uses transaction-scoped `SET LOCAL`; 18 workspace tables have Postgres RLS policies.
- The policies allow legacy/no-context access for compatibility and restrict rows when a workspace context is set. Application-level workspace filtering remains mandatory.
- Evidence writes require a valid `encryptionKeyRef`; artifacts are uploaded via `apps/worker/src/engine/evidence-storage.ts` to S3-compatible storage with `AES256` SSE and a SHA-256 checksum. Missing storage or upload failure stops persistence; no placeholder URI is accepted. Shared report tokens are hashed and revocable. Audit writes are serialized per workspace with a PostgreSQL advisory lock, and privacy anonymization rebuilds affected chains.

### Migrations

Twelve PostgreSQL migrations are committed, in order:

1. `20260630214756_init`
2. `20260630223105_add_new_models_and_indexes`
3. `20260705090000_batch3_cvss_sarif_cost_hashchain`
4. `20260705095000_batch3_missing_tables_columns`
5. `20260705100000_batch3_rls`
6. `20260706010000_schedule_target_fk`
7. `20260706020000_agent_approval_layer`
8. `20260707000100_drop_workspace_slug_idx`
9. `20260707120000_report_fk_composite_indexes_workspace_guard`
10. `20260712130000_lyrashield_scorecards_referrals`
11. `20260713010000_scoresnapshot_rls`
12. `20260713170000_scorecard_events`

CI applies migrations to PostgreSQL 16 and runs a Prisma migration-diff gate. The scorecard-events migration uses Prisma's PostgreSQL-truncated unique-index name (`...dayBuc_key`); changing it recreates rename-only drift. Production uses `migrate:deploy`; never use `db push` as a deployment mechanism.

---

## 6. Environment Contracts

### Product App and Worker

The root `.env.example` is the canonical template. `@lyrashield/config` validates the product runtime at import time.

| Area                    | Variables                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Database                | `DATABASE_URL`, optional `DATABASE_DIRECT_URL`                                                                           |
| Queue                   | `REDIS_URL`                                                                                                              |
| Distributed API limits  | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                                                     |
| Better Auth             | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_COOKIE_DOMAIN`, `ADDITIONAL_TRUSTED_ORIGINS`                       |
| OAuth                   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, optional Google and Azure AD values                                          |
| GitHub App              | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`                                    |
| Public app              | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_MARKETING_URL`, `PORT`                                                               |
| Engine                  | `LYRASHIELD_LLM` fallback, `LYRASHIELD_LUNA_LLM`, `LYRASHIELD_TERRA_LLM`, `LLM_API_*`, `LYRASHIELD_IMAGE`, Azure aliases |
| Evidence storage        | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`                                                |
| Email/notifications     | `BREVO_API_KEY`, `EMAIL_FROM`, `NOTIFICATION_FROM_EMAIL`, `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`                     |
| Billing placeholders    | Polar and Razorpay variables; no billing runtime exists yet                                                              |
| Monitoring placeholders | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`                                                                                   |

Required boot values are `DATABASE_URL`, a 32+ character `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `NEXT_PUBLIC_APP_URL`. If the Upstash URL is configured, its token is required. GitHub private keys must be PEM-formatted.

The engine runner forwards only an explicit environment allowlist plus recognized provider API-key names. Never pass the full parent process environment to the Python subprocess. Production must pin `LYRASHIELD_IMAGE` by digest.

Next.js page-data collection does not reliably load the root `.env`; export required values or provide `apps/web/.env` for local production builds.

### MCP

`LYRASHIELD_API_URL` selects the product API (default `http://localhost:3000`); `LYRASHIELD_API_KEY` supplies MCP authentication when configured. A complete user-facing API-key issuance lifecycle is still pending.

### Marketing Worker

`apps/marketing/.env.example` documents public build inputs:

- `PUBLIC_SITE_URL` — canonical marketing origin
- `PUBLIC_APP_URL` — app origin used for "Sign in" / "Go to app" links (strip trailing slash before build)
- `PUBLIC_X_URL`
- `PUBLIC_INDEXABLE`
- `PUBLIC_POSTHOG_KEY`
- `PUBLIC_POSTHOG_HOST`

`WAITLIST_IP_SALT` is a Worker secret and belongs in local `.dev.vars` or Cloudflare secrets, never in committed public vars. `wrangler.jsonc` supplies the `DB` and `WAITLIST_RL` bindings. Indexable builds require a public HTTPS `PUBLIC_SITE_URL`.

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
pnpm db:migrate           # Create/apply a development migration
pnpm --filter @lyrashield/db migrate:deploy  # Apply committed migrations
pnpm db:push              # Local prototyping only; never production
pnpm db:seed              # Seed demo data
pnpm db:studio            # Open Prisma Studio

# Docker (Postgres, Redis, migrate, web, worker)
docker compose up --build # Build and start the local stack
docker compose build worker  # Build engine-bearing worker using sibling context
docker compose down       # Stop services

# Marketing Worker preview
pnpm --filter @lyrashield/marketing preview  # Worker-backed preview on port 8787
```

**First-time setup**:

1. `docker compose up -d postgres redis` — start dependencies
2. `pnpm install` — install dependencies
3. `pnpm db:generate` — generate Prisma client
4. `pnpm db:migrate` — run migrations
5. `pnpm db:seed` — seed demo data
6. `pnpm dev` — start dev server at `http://localhost:3001` (set `PORT` in `apps/web/.env` if you need a different port)

---

## 8. Implementation Status

This is the code-facing status summary. Product cutlines and release gates live in `PRD.md` Part C; dated implementation detail lives in §§17–35 below.

| Workstream                          | Status                       | Code truth                                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation/auth/tenancy (0–3 + 2.5) | Core complete                | Better Auth, workspaces, RBAC, onboarding, projects, targets, team, GitHub App, RLS, account deletion/anonymization, scoping, pagination, shared UI.                                                                                                       |
| Agent actions/approvals (3.5/7.5)   | Complete                     | Six actions, signed service tokens, registry permissions, queueing, exact input-hash checks, atomic single-use approvals, approval APIs, RLS model, and controlling-terminal MCP mutation approval.                                                        |
| Scan orchestration (4)              | Complete                     | BullMQ producer/consumer, preflight, guarded lifecycle, bounded phases/shutdown, cancellation/retry, infrastructure exit categories, engine runner, artifact parsing, retry-safe findings/evidence persistence, polling UI.                                |
| Engine adapter (5)                  | Code complete, release-gated | Thin adapter and Docker integration pass offline gates; one local Safe sandbox lifecycle completed. Production controlled-scan proof remains unproven.                                                                                                     |
| Normalization/SCA/secrets (6/6.5)   | Complete                     | Normalizer, verifier, bounded/symlink-safe SCA and secrets discovery, batched/deduplicated OSV requests, explicit non-repository skips, scanner orchestrator, SARIF.                                                                                       |
| Remediation/output (7–9)            | Complete                     | Finding APIs/UI, fix proposals, GitHub PR creation, retests, immutable report snapshots/sharing, aggregate launch readiness, scoped notifications, schedules, URL checks, exact-range diff gate. Evidence uploads are checksum-idempotent.                 |
| Scorecards/referrals/distribution   | Complete                     | Versioned scores and immutable snapshots, frozen public scorecards, revocation/supersession, referrals/rewards, premium cards/badges, channel sharing, privacy-safe funnel events, dashboard metrics, waitlist sharing, and report handoff copy.           |
| MCP (9.5)                           | Core complete                | API-backed tools, approval checks, hardened prompt-injection guard (input normalization + expanded pattern set), stdio transport. API-key lifecycle and broader client docs remain.                                                                        |
| Billing/usage (10)                  | Not implemented              | `BillingAccount`, `UsageRecord`, permissions, and env values are schema/config foundations only.                                                                                                                                                           |
| Launch polish (11)                  | Partial                      | UX, accessibility, security hardening, privacy lifecycle, browser E2E, health/readiness, instrumentation, docs, and Docker proof are implemented; controlled scan, production infrastructure, egress, operational monitoring, and marketing launch remain. |
| Phase 2                             | Not implemented              | Enterprise identity, SCIM, advanced policy, private worker, VPC/self-hosting, BYOK/BYOM, and enterprise integrations remain roadmap items.                                                                                                                 |

### Current Verification

- `pnpm lint`: pass
- `pnpm typecheck`: pass across the workspace package graph
- `pnpm test`: **738 tests in 72 files**, pass
- `pnpm test:e2e`: **2 Chromium tests**, pass; covers auth, onboarding, target/scan creation, and cross-tenant scan/finding/report denial
- `pnpm build`: pass for Next.js, worker/agent/MCP TypeScript, and Astro marketing
- `pnpm format:check`: pass
- `pnpm audit --prod --audit-level high`: pass, no known production vulnerabilities
- Prisma validation, deployment, and status: pass; all 16 migrations applied locally
- `git diff --check`: pass
- Engine offline gate: 155 tests + Ruff + formatting + headless mypy + Bandit

### Runtime Truth

- The local Compose architecture includes PostgreSQL, Redis, a migration job, web, and worker.
- The engine-bearing worker image builds and exposes `lyrashield 1.0.4.post1`.
- Missing engine model configuration fails before sandbox pull.
- Historical Docker smoke in §§24–30 proves prior container health, routes, migrations, queue startup, and engine packaging. It does **not** prove a current authorized scan.
- Marketing is implemented and locally Worker-previewed, but Cloudflare production provisioning, domain attachment, indexing, and real-domain QA are not complete.
- PR #52 merged the social distribution loop; PR #53 merged GPT-5.6 routing/caps and its documentation reconciliation; PRs #54–#57 merged the Deep Review v3 remediation; PR #59 preserved deletion attribution and legacy report fallback; PR #60 adds the premium UI and Assurance Story release. Each merged implementation PR passes the applicable CI migration, lint, format, typecheck, test, build, Chromium E2E, SCA/secret, and security-diff gates. External social-network cache/unfurl behavior remains a real-domain release check.

---

## 9. API Reference

Most routes live under `apps/web/src/app/api`; public scorecard OG and badge routes live under `apps/web/src/app/(public)/api`. Protected routes use Better Auth plus workspace permission checks. Inputs are Zod-validated at trust boundaries. List endpoints use cursor pagination where applicable.

| Methods            | Path                                | Purpose                                             |
| ------------------ | ----------------------------------- | --------------------------------------------------- |
| GET                | `/api/health`                       | Process liveness                                    |
| GET                | `/api/ready`                        | PostgreSQL and Redis readiness                      |
| DELETE             | `/api/account`                      | Confirmed account deletion and anonymization        |
| GET, POST          | `/api/auth/[...all]`                | Better Auth handler                                 |
| GET, POST          | `/api/workspaces`                   | List memberships / create workspace                 |
| POST               | `/api/workspaces/active`            | Persist active workspace in HttpOnly cookie         |
| GET, PATCH         | `/api/onboarding`                   | Read/update per-user onboarding state               |
| GET, POST          | `/api/projects`                     | Paginated project list / create                     |
| GET, POST          | `/api/targets`                      | Paginated target list / create with SSRF validation |
| POST               | `/api/targets/[id]/scorecard`       | Publish the current eligible score snapshot         |
| GET, POST          | `/api/team`                         | Paginated team list / invite member                 |
| GET, POST          | `/api/integrations/github/install`  | Installation callback / signed install URL          |
| GET                | `/api/integrations/github/repos`    | List installation repositories                      |
| POST               | `/api/webhooks/github`              | Verify and process GitHub deliveries                |
| GET, POST          | `/api/scans`                        | Paginated scan list / create and enqueue            |
| GET, POST          | `/api/scans/[id]`                   | Scan with events / cancel scan                      |
| GET                | `/api/findings`                     | Paginated finding list                              |
| GET, PATCH         | `/api/findings/[id]`                | Finding detail / update status                      |
| POST               | `/api/findings/[id]/fix-proposals`  | Create fix proposal                                 |
| POST               | `/api/findings/[id]/retests`        | Queue retest                                        |
| GET                | `/api/fix-proposals`                | List proposals                                      |
| POST               | `/api/fix-proposals/[id]/create-pr` | Approval-aware GitHub PR creation                   |
| GET                | `/api/retests`                      | List retests                                        |
| GET                | `/api/launch-readiness`             | Compute launch-readiness verdict                    |
| GET, POST          | `/api/reports`                      | List / generate report                              |
| GET, POST          | `/api/reports/[id]`                 | Read report / share or revoke token                 |
| GET                | `/api/reports/[id]/download`        | Download rendered HTML report                       |
| GET                | `/api/reports/shared/[id]`          | Token-gated public report data                      |
| DELETE             | `/api/scorecards/[id]`              | Revoke a scorecard share                            |
| POST               | `/api/scorecards/events`            | Record allowlisted deduplicated view/share events   |
| POST               | `/api/referrals/capture`            | Validate referral/source and set HttpOnly cookies   |
| POST               | `/api/referrals/claim`              | Claim a new-account referral during onboarding      |
| GET                | `/api/og/score/[slug]`              | Render grade/fixes PNG in wide/square/portrait      |
| GET                | `/api/badge/score/[slug]`           | Render a script-free revocable SVG badge            |
| GET, POST          | `/api/notifications`                | Paginated list / create notification                |
| PATCH              | `/api/notifications/[id]`           | Update notification read state                      |
| GET, POST          | `/api/schedules`                    | Paginated list / create schedule                    |
| GET, PATCH, DELETE | `/api/schedules/[id]`               | Read/update/delete schedule                         |
| GET                | `/api/agent-approvals`              | List approvals                                      |
| POST               | `/api/agent-approvals/[id]/approve` | Approve exact action input                          |
| POST               | `/api/agent-approvals/[id]/deny`    | Deny pending approval                               |

### Response and Client Contracts

Server routes use helpers from `apps/web/src/lib/api-response.ts`:

- success: `{ success: true, data }`
- error: `{ success: false, error: { code, message } }`
- paginated: data plus `nextCursor`

Client components use `apiGet`, `apiPost`, `apiPatch`, `apiDelete`, and `apiGetPaginated` from `apps/web/src/lib/api-client.ts`; do not add raw `fetch` to client components without a concrete need.

Worker-created notifications are workspace-level and may have no `userId`; notification listing must not add a default user filter.

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

- Navigation with icons: Dashboard, Projects, Targets, Scans, Findings, Fixes, Reports, Launch Readiness, Notifications, Schedules, Team, Integrations, Settings
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
- Scan step calls `POST /api/scans`, retains the created scan ID/status, and routes results to the real scan detail page
- Results/Fix steps link into the implemented scan, findings, and remediation surfaces
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
- Loading state: shared `Spinner` with stable layout dimensions
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

**Contracts beyond CRUD inputs**:

- `ApiResponse<T>`, `PaginatedResponse<T>`
- SARIF 2.1.0 report/run/rule/result/location types
- CVSS and scan cost/determinism contracts
- `SCAN_QUEUE_NAME`, `ScanJobData`, `ScanJobResult`
- Agent action definitions/context/results and signed service-token payload
- Approval status and create/approve/deny schemas
- Input schemas for all six agent actions

---

## 12. Logger (`packages/logger/src/index.ts`)

Structured JSON logger with level filtering, recursive secret/PII redaction, circular-safe serialization, `Error` handling, and payload truncation:

```typescript
logger.info("Project created", { projectId: "abc", workspaceId: "xyz" })
// Output: {"level":"info","message":"Project created","timestamp":"2026-07-01T...","projectId":"abc","workspaceId":"xyz"}
```

- Levels: debug, info, warn, error
- `LOG_LEVEL` env var controls minimum level (default: info)
- `createLogger(scope)` returns scoped logger
- Sensitive key names and credential-looking values are masked before serialization; still never log raw secrets deliberately

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
- **Soft deletes**: Use the Prisma extension and the exact model sets in `packages/db/src/scoping.ts`; never assume every model has `deletedAt`
- **Icons**: Use `lucide-react` icons. Each nav item should have a unique icon. Brand icons (e.g. GitHub) are not in lucide v1 — use `GithubIcon` from `@lyrashield/ui`. All decorative icons must have `aria-hidden="true"`
- **UI components**: Use shared components from `@lyrashield/ui` (Button, Card, Badge, Input, Textarea, Select, FormField, EmptyState, Spinner, GithubIcon). Use `buttonVariants`/`badgeVariants` for consistent variant styling. All components use `forwardRef` and `cn()` for class merging
- **Premium design tokens**: Use OKLCH colors, custom shadows, and utility classes from `globals.css` (`.glass`, `.gradient-primary`, `.gradient-hero`, `.text-gradient`, `.shadow-premium`, `.shadow-card-hover`, `.shadow-primary-glow`). All have dark mode variants. Use `rounded-lg` or `rounded-xl` for cards/buttons, not `rounded-md`
- **Responsive**: Mobile-first. Use `flex-col sm:flex-row` for headers, `hidden sm:table-cell` for non-essential table columns, `overflow-x-auto` for tables, `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` for card grids
- **Forms**: Labels must have `htmlFor`/`id` associations. First field should have `autoFocus`. Cancel button should clear errors
- **Error states**: Client components should show error message + retry button on fetch failure
- **Accessibility**: Add `aria-*` attributes to interactive elements (dropdowns, buttons with icons)
- **Audit logs**: Write audit events for sensitive operations and preserve hash-chain semantics; never log raw secrets or tokens
- **Scan lifecycle**: Use guarded transitions from `packages/db/src/scan-transitions.ts`; do not update scan status ad hoc
- **Notifications**: Use `createAndSendNotification`; do not duplicate create/send loops
- **Engine boundary**: Keep product compatibility in the adapter/worker; do not mechanically rename upstream internals

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
14. **Workspace model sets are schema-sensitive** — `SOFT_DELETE_MODELS` may include only models with `deletedAt`; `WORKSPACE_SCOPED_MODELS` may include only models with `workspaceId`
15. **RLS context must be transaction-local** — use `withWorkspaceRLS`; never replace AsyncLocalStorage with a module-level mutable workspace ID
16. **Worker notifications are workspace-level** — do not filter notification lists by `userId` unless the caller explicitly requests it
17. **Schedule target FK is intentional** — preserve migration `20260706010000_schedule_target_fk`
18. **Engine source is the sibling canonical repo** — local Docker builds resolve `../lyrashield-engine` as the named build context; do not create integration clones/worktrees as competing sources of truth
19. **The engine fork is thin** — explicit `STRIX_*` values win over compatibility variables; upstream sync is review-only
20. **Compose Docker socket access is local/dev only** — production sandbox isolation and egress controls require a separate deployment design
21. **Marketing deploy config is generated** — deploy or preview with `apps/marketing/dist/server/wrangler.json`, not the source `wrangler.jsonc`
22. **Marketing indexability is build-time** — `PUBLIC_INDEXABLE=true` requires the final public HTTPS origin and founder approval
23. **Billing/API keys are not shipped features** — schema models and env placeholders do not imply checkout, quota enforcement, or key-management APIs
24. **GitHub uninstall matching has known debt** — store numeric installation ID on `Target` before replacing the current owner-prefix fallback

---

## 16. File Quick Reference

| File                                                 | Purpose                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `AGENTS.md`                                          | Current handoff, execution queue, rules, and landmines                         |
| `PRD.md`                                             | Product specification; Part C owns current status/release gates                |
| `apps/web/src/proxy.ts`                              | Nonce CSP, API rate limiting, and provider-first client-IP extraction          |
| `apps/web/src/app/(dashboard)/layout.tsx`            | Auth, onboarding, workspace shell                                              |
| `apps/web/src/components/sidebar.tsx`                | Responsive dashboard navigation                                                |
| `apps/web/src/components/workspace-switcher.tsx`     | Server-persisted active workspace                                              |
| `apps/web/src/lib/api-client.ts`                     | Typed client request helpers                                                   |
| `apps/web/src/lib/api-response.ts`                   | Standard server response/pagination helpers                                    |
| `apps/web/src/lib/cache.ts`                          | Request-level React `cache()` wrappers                                         |
| `apps/web/src/lib/github-install-state.ts`           | Signed GitHub installation state                                               |
| `apps/worker/src/jobs/run-scan.job.ts`               | End-to-end scan job orchestration                                              |
| `apps/worker/src/engine/runner.ts`                   | Bounded/cancellable engine subprocess + artifact discovery                     |
| `apps/worker/src/engine/output-parser.ts`            | Engine artifact validation/parsing                                             |
| `apps/worker/src/engine/normalizer.ts`               | Finding normalization and deduplication                                        |
| `apps/worker/src/engine/verifier.ts`                 | Finding verification checks                                                    |
| `apps/worker/src/engine/scanner-orchestrator.ts`     | Engine + deterministic scanner merge                                           |
| `apps/worker/src/engine/scanners/sca-scanner.ts`     | Dependency manifests + OSV                                                     |
| `apps/worker/src/engine/scanners/secrets-scanner.ts` | Secret detection/redaction                                                     |
| `apps/worker/src/engine/scanners/url-scanner.ts`     | AI-builder-aware URL checks using `safeFetch`                                  |
| `apps/worker/src/queue.ts`                           | BullMQ worker (re-exports shared enqueueScan)                                  |
| `apps/web/src/lib/queue.ts`                          | Web scan-enqueue wrapper (re-exports shared enqueueScan)                       |
| `apps/agent/src/queue.ts`                            | Agent scan-enqueue wrapper (re-exports shared enqueueScan)                     |
| `packages/integrations/src/queue.ts`                 | Shared getScanQueue/enqueueScan for web, worker, and agent                     |
| `packages/integrations/src/redis.ts`                 | Redis connection helper (GitHub token cache, queue)                            |
| `apps/worker/src/schedules.ts`                       | Atomic schedule claims and enqueueing                                          |
| `apps/agent/src/registry.ts`                         | Action permissions, approval gate, audit logging                               |
| `apps/agent/src/actions.ts`                          | Six registered agent actions                                                   |
| `apps/agent/src/service-token.ts`                    | Signed short-lived service tokens                                              |
| `packages/auth/src/auth.ts`                          | Better Auth server configuration                                               |
| `packages/auth/src/session.ts`                       | Session/workspace/permission guards                                            |
| `packages/auth/src/permissions.ts`                   | Role hierarchy and permission matrix                                           |
| `packages/db/prisma/schema.prisma`                   | PostgreSQL schema                                                              |
| `packages/db/src/scoping.ts`                         | AsyncLocalStorage workspace/soft-delete policy                                 |
| `packages/db/src/rls.ts`                             | Transaction-local Postgres RLS context                                         |
| `packages/db/src/scan-transitions.ts`                | Guarded lifecycle state machine                                                |
| `packages/db/src/scan-service.ts`                    | Serialized scan creation/cancellation                                          |
| `packages/db/src/report-service.ts`                  | Workspace-bound reports and share tokens                                       |
| `packages/db/src/agent-approval-service.ts`          | Approval input hashing and persistence                                         |
| `packages/db/src/notification-service.ts`            | Shared create/send helper                                                      |
| `packages/security/src/ssrf.ts`                      | Shared DNS/IP validation                                                       |
| `packages/security/src/safe-fetch.ts`                | Redirect-hop revalidation                                                      |
| `packages/mcp/src/server.ts`                         | API-backed MCP server                                                          |
| `packages/mcp/src/stdio-transport.ts`                | JSON-RPC stdio transport                                                       |
| `packages/mcp/src/prompt-injection-guard.ts`         | Injection detection/sanitization with normalization and critical-pattern logic |
| `packages/logger/src/index.ts`                       | Circular-safe, truncating, redacting logger                                    |
| `packages/ui/src/index.ts`                           | Shared accessible UI exports                                                   |
| `apps/marketing/astro.config.mjs`                    | Site origin/indexability contract                                              |
| `apps/marketing/src/pages/api/waitlist.ts`           | CSRF-guarded D1 waitlist endpoint with provider-first client-IP extraction     |
| `apps/marketing/wrangler.jsonc`                      | Source bindings/build configuration                                            |
| `Dockerfile`                                         | Standalone web and engine-bearing worker targets                               |
| `docker-compose.yml`                                 | Local dev stack and sibling engine build context                               |
| `engine-NOTICE.md`                                   | Apache-2.0 notices and engine divergence record                                |

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

The historical audit backlog and resolutions remain in `PRD.md` Part B. **Part C is the current backlog and release-readiness source of truth.** Round-2 handoff items (migration drift, CI hardening, supply chain, CSP) are all **DONE** — see §20.

---

## 18. UI/DX Foundation (2026-07-05)

- `packages/ui` became the shared component source for Button, Card, Badge, form controls, FormField, EmptyState, Spinner, LoadMore, and brand icons.
- Dashboard/auth/onboarding surfaces adopted shared tokens, responsive layouts, mobile navigation, accessible labels/states, and stable loading/error/empty states.
- Navigation destinations that were originally stubs are now implemented product pages; current route truth is in §§3 and 9.
- Use the conventions in §§10 and 14 for new frontend work rather than copying dated one-off markup from this checkpoint.

---

## 19. Data Fetching and Design Contracts (2026-07-05)

- Server pages pass initial data to client components; request-local React `cache()` wrappers deduplicate session/workspace/data queries.
- Projects, targets, team, scans, findings, reports, notifications, and schedules use bounded/cursor pagination where applicable; client code uses typed API helpers.
- Evidence encryption references, audit hash chaining, SARIF/CVSS/cost contracts, and Postgres RLS were added before scan data became established.
- RLS now covers 18 workspace tables after the AgentApproval migration. Current database truth is in §5.

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
  3. Resolves the per-mode engine profile, then spawns the child process with filtered env vars (`buildEngineEnv()`)
  4. Captures stdout/stderr with 10MB buffer truncation
  5. 30-minute timeout with SIGTERM → SIGKILL escalation
  6. Emits scan events for RUNNING, output capture, completion
  7. Reads `vulnerabilities.json` + `run.json` from output dir
  8. Returns `{ exitCode, output: ParsedScanOutput }`
- **`resolveEngineProfile(mode)`** — routes Safe/Quick/Standard to the configured Luna deployment at medium reasoning and Deep/Custom to Terra at high reasoning; a missing routed deployment falls back to `LYRASHIELD_LLM`.
- **`interpretExitCode(code)`** — maps engine exit codes: 0 → COMPLETED (SUCCESS), 2 → COMPLETED (VULNERABILITIES_FOUND), all other codes → FAILED.
- **`cleanupEngineWorkspace(dir)`** — removes temp workspace (best-effort, non-fatal).
- Focused runner tests cover exit mapping, termination escalation, output discovery, every routing mode, and fallback selection.

### 21.4 Command Builder (`apps/worker/src/engine/command-builder.ts`)

- **`buildEngineCommand(config)`** — constructs CLI args for the scan engine. Maps repository/URL targets to `--target`, maps Safe/Quick to engine `quick`, Standard to `standard`, and Deep/Custom to `deep`, then adds optional `--instruction` and the enforced `--max-budget-usd` value.
- **`resolveScanBudgetUsd(mode, policyMaxBudgetUsd)`** — accepts a finite positive workspace-policy override; otherwise applies $1.20 Safe/Quick, $3.20 Standard, and $15 Deep/Custom. Unknown modes fail safely to the $15 cap.
- Focused command-builder tests cover target/mode mapping, CLI cap propagation, every default cap, policy override, and invalid-budget fallback.

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

**P2 — High Priority:** 3. **`createPullRequestRecord` bypassed transaction** — In `create-pr/route.ts`, the PR record was created via `createPullRequestRecord()` outside the `$transaction`, risking orphaned records if subsequent steps failed. Fixed by inlining `tx.pullRequest.create()` inside the transaction. 4. **Permissive MEMBER permissions** — `notification.manage` and `schedule.delete` were granted to MEMBER role, allowing members to manage notification settings and delete schedules. Removed from MEMBER; ADMIN+ only. 5. **No timeout on external HTTP calls** — Brevo, Slack, and Discord `fetch` calls had no timeout, risking indefinite hangs. Added `AbortSignal.timeout(10_000)` (10s) to all notification channel calls and `AbortSignal.timeout(30_000)` (30s) to `githubFetch` (GitHub API wrapper). 6. **Unbounded `findMany` in report generator** — `gatherReportData` fetched all findings with no limit, risking OOM for large workspaces. Added `take: FINDINGS_LIMIT + 1` (500) with a `findingsTruncated` boolean in `ReportData` and a user-visible truncation notice in the HTML report.

**P3 — Quality:** 7. **`explainFinding` ignored params** — `category` and `technicalDetail` parameters were accepted but unused. Fixed: `category` maps to human-readable labels via `CATEGORY_LABELS` for better fallback titles; `technicalDetail` is appended to `whatItIs` as "Technical detail: ...". 8. **`as never` casts** — Replaced with proper type casts: `as ScanGoal`/`as ScanMode` in `schedule-service.ts` (importing the enum types from generated Prisma), and `NonNullable<BadgeProps["variant"]>` in `notifications-client.tsx` (importing `BadgeProps` from `@lyrashield/ui`). 9. **Duplicate notification logic** — `createAndSendNotification` logic was duplicated between `apps/worker/src/notifications.ts` and the `create-pr` API route. Extracted into `packages/db/src/notification-service.ts` as a shared function with a `sendFn` callback (avoids cross-package dependency). Both consumers now use it. 3 new tests added. 10. **Dead cleanup effect in findings-client** — `FindingDetailModal` had a `useEffect` that reset state on unmount — unnecessary since React handles this automatically. Removed.

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
- **Footer** — Report ID, "Powered by LyraShield AI" branding
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

### 24.5 Prompt-Injection Defense

**File:** `packages/mcp/src/prompt-injection-guard.ts`

Hardened detection with input normalization (zero-width characters, NFKC normalization, HTML entity decoding) and an expanded pattern set covering instruction override, role hijack, code execution, SQL injection, env extraction, XSS vectors, destructive commands, and prompt extraction. `checkToolCall()` serializes and checks tool args. `sanitize()` uses `normalizeInput()` before applying critical-pattern checks. Strict mode sanitizes suspicious but non-critical patterns with `[REDACTED]` replacement.

**Tests:** `prompt-injection-guard.test.ts` — 9 tests.

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

**MEDIUM:** 3. **Narrowed false-positive patterns** (`normalizer.ts`) — False-positive pattern matching narrowed to only `target` and `endpoint` fields instead of all string fields. Prevents legitimate findings from being flagged as false positives due to keywords in description or title. 4. **LLM usage tracking** (`run-scan.job.ts`) — Parses `llm_usage` from engine output and persists it as a `ScanEvent` with `llm_usage` metadata. Enables cost monitoring and budget enforcement. 5. **MCP tool call audit logging** (`server.ts`) — Added structured audit logging for MCP tool calls. Both allowed and blocked calls are logged with redacted args (tool name, args summary, timestamp, result status). Blocked calls from prompt injection guard are logged at warn level.

**LOW:** 6. **`technicalDetail` in CWE-specific path** (`plain-language.ts`) — Appended `technicalDetail` in the CWE-specific explanation path for consistency with the generic path. Previously, `technicalDetail` was only appended in the generic fallback path. 7. **Golden-file regression test** (`normalizer.test.ts`) — Added a comprehensive golden-file regression test that runs the full normalization pipeline (severity → CWE → CVSS → confidence → false-positive risk → dedup) on a representative set of findings and verifies the output matches expected golden values.

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

### Verification (app)

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

### Verification (engine)

- Engine: **62 tests pass** with Pydantic deprecations treated as errors; Ruff lint and formatting pass; headless mypy passes across 58 source files; Bandit reports zero findings.
- Worker image build runs `lyrashield --version` as a build-time smoke gate and reports **1.0.4**.
- Running worker reports ready, reaches the Docker daemon, and passes the app's **597 tests across 47 files**.
- At this engine-integration checkpoint, missing `LYRASHIELD_LLM` exited cleanly before sandbox setup and no paid/full scan was started. Current routing configuration is documented in §35; controlled-scan proof remains pending.
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
- The canonical engine checkout now has both writable `origin` (`ecryptoguru/lyrashield-engine`) and read-only upstream remotes. Engine PR #1 merged the thin-fork adapter and review-gated sync workflow. No automated sync PR or merge is claimed beyond that reviewed publication.

### Verification evidence and remaining release blockers

- Engine verification passed: frozen sync, Ruff, formatting, **155 pytest tests**, headless mypy across **61 source files**, and Bandit.
- That checkpoint passed 607 tests in 48 files. The current gate is recorded at the top of this document and in §32.
- `docker compose build worker` now completes after the builder scopes its Next.js compilation to `pnpm --filter @lyrashield/web build`, avoiding the unrelated uncommitted `apps/marketing` Cloudflare `workerd` failure. The resulting local worker image ID is `sha256:71d6c104f5d11e30d8f8ee63cef8aacb1819b5ec8a4c3d1987d7fd3dcaddc4e6`; `docker compose run --rm --no-deps worker lyrashield --version` returned `lyrashield 1.0.4.post1`.
- With `LYRASHIELD_LLM` and `LLM_API_KEY` explicitly empty, `lyrashield --non-interactive --target https://example.invalid` exited `1` with `STRIX_LLM` configuration guidance and no `Pulling Docker image` or `Downloading` output. No sandbox launch occurred. The local/dev Compose socket mount remains a development-only sandbox mechanism, and production still requires a separately pinned sandbox image digest.
- At this 2026-07-11 checkpoint, neither `LYRASHIELD_LLM` nor `LLM_API_KEY` was configured for an authorized scan. No external, public, paid, or substitute target was used. Later configuration/routing work is recorded in §35; it does not constitute controlled-scan proof.

---

## §31 — Marketing App Review Fixes (2026-07-11)

### Marketing app overview

`apps/marketing` is the Astro 7 public site for LyraShield AI. It is built with the `@astrojs/cloudflare` adapter and deployed to Cloudflare Workers. It is separate from the Next.js platform (`apps/web`) and includes its own D1 waitlist database, Cloudflare Rate Limits binding, and PostHog analytics.

### Stack

- **Framework:** Astro 7 + `@astrojs/cloudflare` (output: `server` / adapter: `cloudflare`)
- **Runtime:** Cloudflare Workers with `workerd` (nodejs_compat enabled)
- **Database:** Cloudflare D1 (`DB` binding), with `0001_waitlist.sql` and `0002_rate_limit_fallback.sql`
- **Rate limiting:** Cloudflare Rate Limits (`WAITLIST_RL` binding) for the waitlist API
- **Styling:** TailwindCSS v4 CSS-first configuration in `src/styles/global.css`
- **Analytics:** `posthog-js` client-side capture
- **Validation:** Zod v4 for waitlist input; `astro:env/server` for `getSecret("WAITLIST_IP_SALT")`
- **Type generation:** `wrangler types` runs in `predev`/`prebuild`/`prepreview`/`pretypecheck` scripts

### Waitlist API (`src/pages/api/waitlist.ts`)

- `POST /api/waitlist` accepts `application/json`, `multipart/form-data`, and `application/x-www-form-urlencoded`.
- `isTrustedOrigin()` checks `Origin`/`Referer` against the site origin.
- `WAITLIST_IP_SALT` is required; missing salt returns a 500.
- `getClientIp()` uses `cf-connecting-ip` first, then the last `x-forwarded-for` address (not the spoofable first).
- Zod validates email and optional fields.
- `env.DB` inserts into `waitlist_signups` with rate-limiting via `WAITLIST_RL`.
- Returns JSON or HTML depending on `Accept` header.

### SEO / static assets

- `src/components/JsonLd.astro` serializes JSON-LD with `<` escaped to `\u003c` to prevent `</script>` injection.
- `astro.config.mjs` is the build-time source for the site origin, indexability, and optional X URL. It rejects indexable builds without a public HTTPS `PUBLIC_SITE_URL`.
- `SeoHead.astro`, homepage JSON-LD, blog JSON-LD, `robots.txt`, RSS, and the sitemap derive their origin from Astro's configured `site`; canonical, Open Graph, and sitemap URLs therefore cannot diverge during a configured build.
- `src/pages/robots.txt.ts` emits `Sitemap: <site>/sitemap-index.xml` when indexable and `Disallow: /` otherwise.
- `src/pages/rss.xml.ts` uses `description` for the RSS summary; raw `post.body` markdown is no longer exposed as `content`.
- `src/pages/llms.txt.ts` is a dynamic Worker route: it returns 404 before launch and generates an LLM-readable summary only for an approved indexable build.

### Generated-file hygiene

- `apps/marketing/.gitignore` ignores `dist/`, `.astro/`, `.wrangler/`, `.dev.vars`, and `worker-configuration.d.ts`.
- `wrangler types` generates `worker-configuration.d.ts` before build/dev/preview/typecheck.
- `astro.config.mjs` deliberately does not validate secrets at static build time; the waitlist endpoint validates the required Worker secret at request time.

### Configuration placeholders

- `wrangler.jsonc` has `database_id` and `ratelimits.namespace_id` placeholders with `// Replace before deploying` comments.
- `.dev.vars.example` provides a local `WAITLIST_IP_SALT` template.
- `.env.example` documents the public build values; `.dev.vars` carries local Worker secrets.
- `preview`, `deploy`, and `deploy:preview` use Astro's generated `dist/server/wrangler.json`, which points assets at `dist/client`.

### Marketing verification

- `pnpm install` passes; lockfile updated.
- `pnpm --filter @lyrashield/marketing typecheck` passes.
- `pnpm --filter @lyrashield/marketing build` passes.
- `pnpm --filter @lyrashield/marketing lint` passes (`eslint src --max-warnings 0`).
- A local Worker smoke passes at `http://localhost:8787`: `/`, `/robots.txt`, and `/sitemap-index.xml` return 200; pre-launch `/llms.txt` returns 404.

### Caveats

- `pnpm peers check` still reports an unmet `tailwindcss` peer warning for `@tailwindcss/typography@0.5.20`. `tailwindcss@4.3.2` is installed and satisfies the published range (`>=3.0.0 || >=4.0.0 || insiders`), the lockfile resolves the peer, and build/typecheck/lint pass, so this is a `pnpm peers check` false positive.

---

## §32 — Release-Hardening Closure (2026-07-11)

- Evidence storage now fails closed when S3-compatible storage is absent or an upload fails; placeholder evidence URIs are no longer produced.
- Audit creation uses a transaction-scoped PostgreSQL advisory lock per workspace. Concurrent writes remain one linear chain. Account deletion blocks sole owners, anonymizes loose user references, deletes auth/membership state, and rebuilds affected audit chains before appending `account.deleted`.
- MCP stdio reads standard `tools/call.params.arguments`. The API client propagates already-aborted signals and distinguishes cancellation from timeout.
- Web rate limiting trusts only `TRUSTED_PROXY_IP_HEADER`; ingress must strip incoming copies. The marketing D1 fallback limiter uses one conditional insert statement instead of a count/insert race.
- `/api/health` reports liveness, `/api/ready` checks PostgreSQL and Redis, and `instrumentation.ts` sends unhandled Next.js request errors through the shared structured logger.
- Playwright runs an isolated production preview on port 3100 and verifies anonymous denial, email signup/signin, workspace onboarding, target creation, scan queue creation, and cross-tenant scan/finding/report denial.
- CI now runs `format:check` and Chromium E2E. Docker contexts exclude nested build output and the engine virtualenv; the measured contexts fell from 565/379 MB to 1.09 MB/22.8 KB. The worker image remains intentionally larger than a compiled-only runtime because shared workspace packages still execute TypeScript source.

### Verification at this 2026-07-11 checkpoint

- `pnpm test`: **625 tests in 56 files**
- `pnpm test:e2e`: **2 Chromium tests**
- `pnpm typecheck`: pass
- Full lint, formatting, build, dependency-audit, Docker, and diff checks must be rerun after documentation formatting before merge.

---

## §33 — LyraShield Score, Public Scorecards & Referrals (2026-07-12, PR #43 + review fixes)

Implements the "LyraShield Score, Shareable Scorecard & Referral System — Engineering Spec v1" (Phases 0–2; Phases 3–4 deliberately deferred). All 7 founder decisions from the spec are resolved and reflected here: fully public methodology, "LyraShield Score" naming, agent-minute rewards, capped OSS tier deferred to Phase 3, supersession notices, ACCEPTED_RISK at 50% weight, and split SEO indexing.

### Score engine — `packages/score` (new package)

- `computeScore(findings, scan)` is a **pure, deterministic, versioned** function (`SCORE_MODEL_VERSION = "lyrashield-score/1.0.0"`); the db layer owns persistence, never score math.
- Deductions from base 100 (floor 0): verified CRITICAL −25 / HIGH −10 / MEDIUM −4 / LOW −1 / INFO 0; unverified ×0.25; `ACCEPTED_RISK` ×0.5. Round half-up.
- Grade bands A+ ≥98 (and zero open findings ≥ MEDIUM), A ≥90, B ≥80, C ≥65, D ≥50, else F. Hard caps (only ever lower): open verified CRITICAL → C, open verified HIGH → B, active verified secret → D.
- `shareEligible` requires mode STANDARD/DEEP on the canonical branch. v1 note: the worker always scans the target's canonical checkout (no per-ref scans exist), so the canonical-branch input is structurally true; the scanned branch is recorded in `breakdown.scannedBranch` for the day ref-scoped scans land.
- Table-driven tests cover every deduction weight, every band boundary, the A+ rule, cap stacking, the zero floor, open-vs-accepted cap semantics, and the share-eligibility matrix.

### Persistence — `packages/db/src/score-service.ts` + migration `20260712130000`

- New models: `ScoreSnapshot` (immutable, `@@unique(scanId)`), `ReferralCode` (side table keyed by Better Auth `userId` — the `User` model is untouched), `ReferralAttribution` (`referredUserId @unique`), `ScorecardShare` (frozen `publicPayload`, unguessable 16-char slug). New enums: `ScoreGrade`, `ReferralStatus`. Purely additive migration.
- `completeScanWithScore()` atomically completes a VERIFYING scan, creates its snapshot (idempotent via the scanId unique), and wires the previously dormant fields: `Scan.riskScoreBefore/After` and `Project.riskScore` (min live snapshot score across targets).
- `buildScorecardPayload()` is the **only** constructor of public payloads — the §5 disclosure allowlist (grade, scope, scannedAt, modelVersion, resolvedFindings; never open counts/titles/CWEs/target URLs). A regression test asserts the exact key set.
- Share-eligibility is additionally gated server-side on triage ratio (accepted-risk + false-positive ≤ 25% of findings).
- `attributeReferral()` enforces: no self-referral, and **no retroactive attribution** — the referred account must be newer than `NEW_ACCOUNT_WINDOW_MS` (7 days). `qualifyReferralForWorkspace()` rewards both sides exactly once (`UsageRecord` upserts keyed on the attribution id; `REFERRAL_BONUS_MINUTES = 30` agent minutes each) when the referred owner's first real scan completes.
- Audit events: `scorecard.share.created`, `scorecard.share.revoked`, `referral.rewarded`.

### Web surfaces — `apps/web`

- Public (no auth, no session reads; rendered exclusively from the frozen payload): `/(public)/score/[slug]` page with the supersession notice ("a newer scan of this target exists" — boolean only, never the newer score), `/(public)/score/methodology` (public methodology, founder decision #1), `/(public)/api/og/score/[slug]` OG image (dark terminal register, 1200×630, CDN-cacheable). Unknown/revoked/expired slugs 404. `/score/*` responses add `Referrer-Policy: no-referrer` via `proxy.ts`; all `/api/*` routes remain behind the shared 30 req/min/IP proxy limiter.
- Authed: `POST /api/targets/[id]/scorecard` and `DELETE /api/scorecards/[id]` — RBAC-restricted to OWNER/ADMIN/SECURITY_ADMIN/APPSEC_MANAGER, tenant-scoped via `requireWorkspaceAccess` + workspace-scoped queries, audit-logged. Target detail page shows the grade card with a below-B publish warning.
- Referral loop: `/api/referrals/capture` validates the code and sets a 30-day `ls_ref` cookie; `/api/referrals/claim` (fired from onboarding) attributes via the gated service function using the `TRUSTED_PROXY_IP_HEADER`-derived IP hash.

### Marketing waitlist referrals (Phase 0) — `apps/marketing`

- D1 migration `0003_waitlist_referrals.sql` adds `referral_code` / `referred_by` / `referral_count`; signups mint an 8-char base32 code, `?ref=` attribution bumps the referrer's count, and `GET /api/waitlist/position` reports a ladder position (created-at order minus referrals).
- **Non-leaking responses preserved:** fresh, duplicate-email, and honeypot submissions all return the identical `{ success, referralCode }` shape — duplicates return the existing row's code (backfilled if the row predates referrals), honeypots return a never-persisted decoy. The endpoint remains an email-enumeration dead end.

### Review fixes applied on top of the original PR #43 commit

1. Waitlist enumeration leak (duplicate/honeypot responses lacked `referralCode`) — fixed as above.
2. `isDefaultBranch` was derived from `target.branch !== null` (meaningless) — replaced with documented v1 canonical-checkout semantics + `breakdown.scannedBranch`.
3. Referral claim could attribute pre-existing accounts retroactively — now rejected in the service (7-day new-account window).
4. Supersession notice (founder decision #5) implemented end to end.
5. Reward quantity extracted to `REFERRAL_BONUS_MINUTES`; payload construction centralized in exported `buildScorecardPayload`; stray comment removed.
6. Test coverage brought up to the spec's verification plan (engine boundary table, allowlist regression, self-referral/old-account rejection, snapshot idempotency).

## §34 — Social sharing and activation loop (2026-07-13, PR #52)

- `/(public)/score/[slug]` now emits scorecard-specific canonical, Open Graph, and Twitter metadata, keeps individual cards `noindex`, preserves the methodology as the indexable authority, and uses a prominent “Check my app before launch” referral CTA.
- `/api/og/score/[slug]` renders grade or verified-fix cards as 1200×630 link previews, 1080×1080 squares, or 1080×1350 feed images from the existing frozen `ScorecardPayload` only. `/api/badge/score/[slug]` returns a short-cache, script-free SVG README badge; revoked/expired shares 404 on every surface.
- `ScorecardShareComposer` provides native sharing with file feature detection plus LinkedIn, X, Bluesky, WhatsApp, Reddit, email, copy, download, README badge, and browser clipboard fallback. Shared links carry allowlisted source/UTM tags while retaining the referral code; target pages select the current publisher's share so another admin cannot receive that publisher's referral attribution.
- Migration `20260713170000_scorecard_events` adds `ScorecardEvent` with a share FK, time-series indexes, and a database unique constraint over share/event/channel/session-hash/day. Rows record only `shareId`, event/channel/variant/source allowlists, a one-way hash of a random session identifier, and a UTC day bucket. `getPublicScorecard()` is read-only so page renders and crawler/card fetches no longer inflate `viewCount`; human views are deduplicated by share/event/channel/session/day.
- `/api/scorecards/events` rejects unknown keys and requires a channel for `SHARE`. Browser privacy signals (`DNT`/Global Privacy Control) suppress client event emission. `VIEW`/`SHARE` are product-funnel diagnostics, not external impressions or verified conversions.
- `/api/referrals/capture` stores the validated referral code and allowlisted source separately in 30-day HttpOnly cookies. `/api/referrals/claim` passes both into the new-account-only attribution service and deletes both cookies. The target page resolves the current publisher's share so a different workspace admin cannot inherit the publisher's referral credit.
- The target scorecard panel shows human views, share handoffs, and referred signup counts. The marketing waitlist success state shows ladder position and direct channel buttons; report sharing provides copyable/email client-handoff text.
- Regression coverage locks the event boundary, referral source cookie, public-payload allowlist, URL/caption encoding, and human-view counting. Local PostgreSQL migration `20260713170000_scorecard_events` applied successfully; desktop and 390×844 browser QA covered metadata, both card variants, all image formats, badge output, clipboard fallback/error recovery, zero horizontal overflow, and clean console output.
- PR CI initially caught PostgreSQL identifier truncation in the manually named unique index. The migration now uses Prisma's exact `ScorecardEvent_shareId_eventType_channel_visitorHash_dayBuc_key` name; the rerun passed migration diff plus all required GitHub checks before merge.
- Production validation still requires the approved public HTTPS app origin: test canonical/OG/Twitter tags, 1200×630/1080×1080/1080×1350 assets, the SVG badge, revoked/expired 404 behavior, source/referral continuity, event deduplication, and external-platform cache refreshers. Local rendering is not proof of a live social unfurl.

## §35 — GPT-5.6 mode routing and enforced scan budgets (2026-07-13)

- `apps/worker/src/engine/runner.ts` resolves one engine profile per scan. Safe, Quick, and Standard use `LYRASHIELD_LUNA_LLM` with medium reasoning; Deep and Custom use `LYRASHIELD_TERRA_LLM` with high reasoning. If the selected variable is empty, `LYRASHIELD_LLM` remains the backward-compatible fallback.
- The resolved model and reasoning effort override only the spawned engine process. Azure credentials, endpoint, and API version continue through the existing generic/Azure allowlist; routing does not duplicate secrets or create separate queues.
- `apps/worker/src/engine/command-builder.ts` applies positive default caps of $1.20 for Safe/Quick, $3.20 for Standard, and $15 for Deep/Custom. Unknown modes receive the conservative $15 fallback. A finite positive `Policy.maxBudgetUsd`, fetched with `workspaceId` and soft-delete scope, overrides the mode cap.
- `run-scan.job.ts` passes the cap to the engine's `--max-budget-usd` guard and records a `budget_cap` event with the amount and source. The `engine_start` event records model and reasoning selection; provider-reported `llm_usage` remains separately persisted after execution.
- This is mode-level routing, not a within-scan cascade: one engine invocation uses one model. Luna discovery followed by Terra validation inside the same scan, provider prompt-cache orchestration, billing-plan quotas, and cross-workspace cost policy remain roadmap work.
- Configuration is propagated through `packages/config`, `turbo.json`, `docker-compose.yml`, `.env.example`, and the deployment runbooks. Regression tests cover every mode, fallback routing, policy overrides, invalid policy budgets, and CLI cap propagation. The full local gate passes 689 Vitest tests in 65 files, lint, typecheck, and production build.

## §36 — Deep Review v3 remediation (2026-07-14, PRs #54–#57)

This pass closed the review queue in four focused, CI-gated merges while preserving the existing package and service boundaries.

### PR #54 — approval, deletion, proxy, and RLS boundaries

- `AgentApproval` now retains execution time/result, and execution claims the approval with an atomic compare-and-set so concurrent or repeated mutation attempts cannot replay it. Result-recording failure remains non-fatal and never reopens the consumed approval.
- Account deletion anonymizes referral attribution and scorecard publisher ownership in addition to the existing auth, membership, notification, and audit-chain handling.
- Production configuration requires `TRUSTED_PROXY_IP_HEADER`; ingress must strip client-supplied copies and set the authoritative value. Degraded local limiting warns once instead of silently pretending to identify clients.
- RLS documentation now matches the actual table coverage, and a source-level regression test keeps referral/scorecard writes behind `score-service.ts`.

### PR #55 — scan pipeline and MCP mutation approval

- The scanner orchestrator records explicit skips for non-repository targets. SCA batches OSV `querybatch` requests at 100 entries, deduplicates/cache-hits within a run, bounds manifest/dependency work, and skips symlinks; secret discovery follows the same bounded/symlink-safe policy.
- Each scanner phase has a validated timeout (`SCANNER_PHASE_TIMEOUT_MS`, default 600000 ms). Worker shutdown is bounded to 25 seconds, and engine launch/exit handling distinguishes missing/forbidden executables and OOM/SIGKILL infrastructure failures from product findings.
- Evidence has a `(findingId, checksum)` uniqueness boundary; new, reopened, and retried findings use conflict-safe persistence so a retry cannot duplicate uploaded evidence metadata.
- MCP mutating calls prompt on `/dev/tty`; stdout stays JSON-RPC-only. A missing controlling terminal denies the mutation. This is the approved interactive decision, not a bypass or implicit approval.
- The GitHub workflow warns for DEEP scans, runtime backends are enum-validated, and upstream GitHub error bodies are truncated before logging/return.

### PR #56 — report, readiness, scorecard, and budget truth

- Reports persist `contentJson` when created, and download/share paths render that immutable snapshot rather than rebuilding from mutable findings.
- Launch readiness uses database aggregates by severity/status/verification rather than a paginated finding list, preserving correctness beyond 100 findings.
- Scorecard publishing returns persisted human-view/share/referral counts from the owning service.
- `PLATFORM_MAX_SCAN_BUDGET_USD` defaults to $50 and clamps policy overrides. Engine-reported cost is retained after execution; over-cap results emit a scan event and structured warning. This complements the engine's pre-run cap but does not claim an application-side mid-process kill signal that the engine contract does not expose.

### PR #57 — sharing, notification, accessibility, and workflow edges

- Scorecard event deduplication uses the server-issued HMAC-signed `ls_scorecard_visitor` HttpOnly cookie; client-supplied visitor UUIDs are not trusted. Event data retains the strict privacy allowlist.
- Supersession checks include `workspaceId`; referral/share source enums are centralized in `apps/web/src/lib/scorecard-sharing.ts`; the public-score lookup has a matching composite index.
- Bulk notification reads require both workspace and user scope. Clipboard success UI updates only after a successful write. Scorecard revocation uses an Escape-cancellable, focus-managed `alertdialog`.
- The gitleaks workflow scans `base..head`, with regression coverage locking the commit range.

### Verification and remaining release truth

- Current local gate: 709 Vitest tests in 68 files, 2 Playwright Chromium tests, lint, typecheck, production build, formatting, Prisma validate/deploy/status, production dependency audit with no known vulnerabilities, and `git diff --check`.
- PRs #54–#57 passed GitHub CI, including migration drift/application, SCA/secrets, and the LyraShield security diff gate. CodeRabbit was rate-limited on the final PR and produced no line review; required checks and the repository's full local/CI gates passed.
- No authorized sandbox scan or production deployment was performed. Model credentials, an approved target, pinned sandbox digest, production infrastructure/egress, public domain, and real-platform social unfurl validation remain explicit release gates in `PRD.md` Part C and `AGENTS.md`.

## §37 — Premium UI and Assurance Story reports (2026-07-14, PR #60)

- `apps/web/src/app/globals.css`, `ThemeProvider`, and the Astro theme bootstrap provide shared semantic light/dark tokens, no-flash preference restoration, reduced-motion support, 44px controls, and a 320px minimum responsive boundary.
- The authenticated shell uses the Shadcn Sheet primitive for focus-trapped mobile navigation. Tabs, Tooltip, and Skeleton are the only other added primitives; `@lyrashield/ui` remains the canonical component layer and report/dashboard charts use native SVG/CSS.
- `/dashboard` is a workspace-scoped security command center with score, severity, trend, remediation, and recent-activity visuals. Date rendering uses a deterministic `en-US`/UTC formatter to prevent server/client hydration drift.
- Report generation stores a versioned immutable Assurance Story snapshot for executive, developer, or compliance audiences. The shared report renderer exposes only the sanitized snapshot, generic target/title copy, and explicit methodology/limitations; public pages are `noindex` and `no-referrer`.
- Regression coverage locks immutable report behavior, V2 assurance aggregation/HTML output, UI control sizing, and deterministic date formatting. The verified local gate is 711 Vitest tests in 69 files, 2 Chromium E2E tests, lint, typecheck, production build, formatting, production dependency audit, `git diff --check`, and browser QA across both themes and every dashboard route at 320px.
- Production-domain visual/unfurl validation, external email delivery, authorized model scans, and Cloudflare production bindings remain release gates; this work does not claim them.

## §38 — Vibe Security 50 coverage contract and browser-local tools (2026-07-14)

- `packages/security/src/vibe-security-controls.ts` is the executable registry for the 50 researched issue classes. It separates 43 machine-testable controls from 7 evidence-required operational controls, sends applicable controls to the engine as a `coverage_contract` event, and never converts an absent finding into a pass. `docs/vibe-security-50.md` is the human-readable contract.
- The worker adds bounded SCA manifest parsing for Maven/Gradle, agent-instruction checks, CI confused-deputy checks, URL signatures, and normalized coverage reporting. The existing scan detail UI labels the result scope rather than promising all controls were exercised.
- Docker worker hardening keeps Git available for repository clones and reaches the Docker sandbox through its bridge address from inside the worker container. The compose sandbox reference is digest-pinned. A local Safe scan against an approved public repository exercised the lifecycle with Luna/medium routing and recorded a post-run budget-overage warning; zero findings is target-scoped and does not establish production or exhaustive coverage.
- `apps/marketing/src/pages/tools/` adds five privacy-first browser-local tools: checklist, pasted-header/CORS review, selected-file secret pattern scan, pasted-SQL RLS lint, and non-production JWT claim inspection. Inputs are deliberately never sent to an API. Chrome browser QA covered tool rendering and JWT, RLS, and headers interactions with a clean console; marketing lint/typecheck/build also pass.
- The dated SEO/AEO/GEO plan contains the 100-topic map and publishing rules. It intentionally keeps editorial work draft-only and rejects a burst of thin pages; the authority article and substantive supporting drafts remain editorial work, not implemented public content.
