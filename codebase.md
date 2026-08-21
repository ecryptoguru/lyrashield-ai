# LyraShield AI — Codebase Guide

> **Purpose:** Maintained implementation map for the canonical `lyrashieldai` repository. `AGENTS.md` owns the current handoff/rules; `PRD.md` Part C owns product status and release gates. Running code and schema override documentation.
>
> **New agent? Start with [`AGENTS.md`](./AGENTS.md)** (repo root) for current state, the execution queue, and the landmines — then use this file as the deep code map and `PRD.md` Part C as the backlog and release-readiness source of truth.
>
> **Current architecture baseline — updated 2026-08-13:** the monorepo contains the web, worker, marketing, and motion apps plus shared product packages. Child-table RLS is restored after the historical `42501` incident, and the release gate covers lint, typecheck, E2E, production build, formatting, migration replay/drift, SCA/secret scanning, security diff, and repository diff checks. Executable schemas and test output—not copied counts in this document—are authoritative. Sections 17 onward are dated implementation history; their older counts and branch names are checkpoints, not the current gate.

---

## 1. System Overview

LyraShield AI is a multi-tenant, evidence-backed release-assurance platform for GitHub repositories and deployed URLs.

**Core product loop**: `Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report`

**Architecture boundary**:

- **This monorepo** (TypeScript/Astro): product UI and APIs, auth/tenancy, scan orchestration, deterministic scanners, findings, remediation, reports, schedules/notifications, agent actions, MCP, and marketing.
- **`lyrashield-engine`** (separate Python repo): controlled derivative over a pinned Strix substrate. The worker calls the `lyrashield` entry point as a subprocess; no engine internals are imported.
- **Not yet implemented:** billing/usage enforcement and the user-facing API-key lifecycle. Controlled-scan and production-infrastructure proof remain release gates. See `PRD.md` Part C.

### Engine Repo Status

The canonical engine repo is `ecryptoguru/lyrashield-engine`. It is a controlled derivative: LyraShield owns the product execution contract while retaining reviewed upstream runtime/tooling where that reduces maintenance.

- **Repo:** `ecryptoguru/lyrashield-engine`
- **Upstream remote**: `https://github.com/usestrix/strix.git`
- **Recorded upstream release/base:** `v1.5.3` / `7cc9fa9faa0179fc7e35111102fe3d20a9028393`
- **Engine version:** `1.2.0`
- **Compatibility:** maps `LYRASHIELD_*` only when the corresponding `STRIX_*` value is unset; explicit upstream values win; the product entry point forces upstream telemetry to `0`
- **Model config:** the engine accepts only GPT-5.6 Terra or Luna deployment names. Before spawning it, the TypeScript worker resolves `LYRASHIELD_LUNA_LLM` for Safe/Quick/Standard or `LYRASHIELD_TERRA_LLM` for the Deep/Custom coordinator, falling back to `LYRASHIELD_LLM`; Deep/Custom child specialists receive Luna/high through the separate delegate route. Empty allowlisted environment values are not forwarded to the engine, preventing them from shadowing a valid fallback. Per-request receipts retain their actual model and cache buckets for mixed-model reconciliation. Perplexity and other non-OpenAI provider credentials are not part of the worker boundary; Parallel Search is configured through `LYRASHIELD_WEB_SEARCH_*` values and requires `LYRASHIELD_WEB_SEARCH_API_KEY` to be useful.
- **Artifacts:** worker accepts `strix_runs` and legacy `lyrashield_runs`, with `run.json` or `vulnerabilities.json`
- **Sync model:** stable-release tree imports on review branches; human approval and green CI are required, with no force-push or automatic conflict resolution
- **Verification:** `scripts/verify-controlled-derivative.sh` owns the footprint, Ruff, formatting, pytest, mypy, Bandit, native-binary, sandbox, and public worker-contract gates; current command output is authoritative

### Engine Boundary

The engine-bearing worker image builds from the sibling canonical repo through a named Docker build context. `lyrashield --version` is a build gate. Missing model configuration exits before sandbox image setup.

Production publication and promotion are separate boundaries: main CI verifies a SHA-only worker image digest and its app/engine OCI labels; the dedicated worker VM runs only the operator-promoted `@sha256:` reference. A promotion updates that runtime reference, restarts the systemd worker, and reconciles the configured and running digest, labels, Docker health, and scan readiness. The previous digest remains the rollback target, so pinning prevents silent tag movement without preventing verified updates.

Exit-code contract:

- `0`: completed without findings
- `2`: completed with findings
- other nonzero exits: runtime/configuration failure

An approved production Standard/Luna repository scan exercised the deployed worker and engine with retained lifecycle events, findings, a Vibe Security 50 ledger, and an immutable manifest. That target- and version-scoped run is not a security guarantee or proof of universal control coverage; Deep/Terra execution, current image provenance, retained evidence, and transport-level egress enforcement remain separate gates.

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
| Testing                 | Vitest + Playwright              | Current release-gate command output is authoritative |
| Worker                  | Node.js/TypeScript + tsx         | BullMQ jobs, schedules, engine/scanner orchestration |
| Job queue               | BullMQ                           | 5.80.x                                               |
| Agent service           | Node.js/TypeScript               | Signed tokens, registry, actions, approval gate      |
| MCP                     | JSON-RPC over stdio              | API-backed tools + prompt-injection guard            |
| Scan engine             | Python controlled derivative     | 1.2.0 over pinned Strix v1.5.3 substrate             |
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
│   │       │   ├── api/       # 50 protected/public-data route files; see §9
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
│   ├── desktop/               # Tauri v2 BYOK desktop app (LyraShield Local/Desktop)
│   │   ├── frontend/          # React 19 + Vite + Tailwind v4 webview
│   │   │   └── src/screens/   # Activation, Setup, Scan, ScanProgress, LicenseStatus, Sync
│   │   └── src-tauri/         # Rust core: license (ed25519), byok (keychain), runtime, scan, sync, updater
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
│   │   │   ├── schema.prisma # 40 models, 18 enums
│   │   │   └── migrations/   # 28 committed PostgreSQL migrations
│   │   └── src/              # Prisma client (with audit-hash extension), RLS/scoping, domain services
│   ├── integrations/          # GitHub, notification delivery, Redis, and shared queue helpers
│   ├── logger/                # Structured redacting logger
│   ├── mcp/                   # Tools, server, stdio transport, injection guard
│   ├── agent-plugin/          # Agent Plugins v0.1.17 (plugin.json, mcp.json, skills, client shims; Cursor streamable-http)
│   ├── agent-registry/        # 30 entries covering 24 distinct agents across 4 install strategies
│   ├── agent-rules/           # Agent policy and rule rendering
│   ├── cli/                   # CLI v0.1.0: login, scan, findings, fix-plan, gate, agents, rules, approvals, mcp
│   ├── cli-alias/             # CLI alias package
│   ├── sdk/                   # SDK package
│   ├── billing/               # Polar + Razorpay dual-gateway, usage metering, entitlements, trial, grace, geo-routing
│   ├── pricing/               # Plan definitions (TRIAL/STARTER/PRO/TEAM/AGENCY), minute packs, local SKUs
│   ├── licenses/              # ed25519 signed license sign/verify for Local/Desktop app
│   ├── affiliate/             # Commission engine, attribution, fraud controls, payout ledger (RazorpayX/Payoneer)
│   ├── eval-ai-safety/        # AI safety eval harness (OWASP Gen AI + MLCommons AILuminate)
│   ├── evidence-storage/      # Envelope encryption (AES-256-GCM) for scan artifacts
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

The Prisma schema is `packages/db/prisma/schema.prisma` (66 models, 24 enums). Prisma 7 reads connection configuration from `packages/db/prisma.config.ts`; generated client output lives under `packages/db/src/generated/prisma` and is gitignored.

### Model Groups

**Better Auth managed:** `User`, `Session`, `Account`, `Verification`, `DeviceCode`, `Jwks`, `OauthClient`, `OauthRefreshToken`, `OauthAccessToken`, `OauthConsent`, `OauthResource`, `OauthClientResource`, `OauthClientAssertion`.

**Workspace/access:** `Workspace`, `WorkspaceMember`, `Invitation`, `ApiKey`, `AgentApproval`, `OnboardingState`, `NotificationPreference`.

**Projects, targets, policy, integrations:** `Project`, `Target`, `CredentialSet`, `TargetDomainVerification`, `Policy`, `Integration`, `WebhookEvent`.

**Scan/remediation/output:** `Scan`, `ScanEvent`, `Finding`, `Evidence`, `ScanResultManifest`, `ScanCoverageReceipt`, `FindingCandidate`, `FindingVerification`, `FixProposal`, `PullRequest`, `Ticket`, `Retest`, `Report`, `Notification`, `Schedule`, `UsageRecord`, `AuditLog`.

**Score/growth:** `ScoreSnapshot`, `ReferralCode`, `ReferralAttribution`, `ScorecardShare`, `ScorecardEvent`.

**AI App Security (private, RLS-enforced):** `AiSecurityScoreSnapshot` (one-to-one with `Scan`, public sharing disabled, persisted via `withWorkspaceRLS`).

**AI assurance (private, RLS-enforced):** `AiSystemProfile`, `AiSystemProfileVersion`, `ThreatModel`, `ThreatModelVersion`, `ControlEvidence`, `ControlEvidenceVersion`.

**Billing (Sprint 10):** `BillingAccount` (workspace billing state, provider, plan, trial, period, spend limit), `MinutePack` (purchased minute packs with 180-day expiry), `UsageRecord` (idempotent usage metering with `idempotencyKey @unique`).

**Licenses (Sprint 10 Track B):** `License` (signed ed25519 license with SKU, seats, machines, update eligibility, perpetual fallback), `LicenseActivation` (per-machine activation tracking), `LicenseKey` (hashed key lookup), `SyncCursor` (cloud sync cursor per workspace+license), `LicenseRevocation` (revocation record).

**Affiliate (Sprint 10 Track C):** `Affiliate` (affiliate profile, rates, reserve, payout method), `AffiliateProgram` (versioned program terms), `AffiliateLink` (referral codes), `Click` (immutable click tracking), `AttributionToken` (cookie-backed attribution tokens), `AffiliateSubscription` (referred subscription tracking with 12-month cap), `Conversion` (monetizable payment events), `Commission` (computed ledger entries with Decimal(19,4) amounts), `Payout` (payout records), `PayoutItem` (payout line items linking commissions).

**Advisory cache:** `AdvisoryCacheEntry`.

### Isolation and Deletion

- `packages/db/src/scoping.ts` owns the AsyncLocalStorage workspace context and the exact model allowlists for automatic workspace and soft-delete filters.
- `WorkspaceMember` is excluded from automatic workspace scoping so the workspace switcher can query memberships. `OnboardingState` is user-scoped. Never add models to an allowlist unless the matching schema column exists.
- `withWorkspaceRLS(workspaceId, fn)` in `packages/db/src/rls.ts` uses transaction-scoped `SET LOCAL`; 18 workspace tables have Postgres RLS policies.
- The policies allow legacy/no-context access for compatibility and restrict rows when a workspace context is set. Application-level workspace filtering remains mandatory.
- Evidence writes require a valid `encryptionKeyRef`; artifacts are uploaded via `apps/worker/src/engine/evidence-storage.ts` to S3-compatible storage with `AES256` SSE and a SHA-256 checksum. Missing storage or upload failure stops persistence; no placeholder URI is accepted. Shared report tokens are hashed and revocable. Audit writes are serialized per workspace with a PostgreSQL advisory lock, and privacy anonymization rebuilds affected chains.

### Migrations

Fifty-five PostgreSQL migrations are committed, in order. The earliest thirteen established the core schema through August 2026; Sprint 10 added nine more in August 2026:

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
13. `20260813170902_add_ai_security_score_snapshot`
    14–22. Sprint 10 migrations (August 2026): `20260818000000_sprint10_starter_enum` (adds `STARTER` to `WorkspacePlan`), `20260818000001_sprint10_billing_fields` (billing fields, workspace grace/trial, `MinutePack`), `20260818000002_track_b_licenses` (`License`, `LicenseActivation`, `LicenseKey`, `SyncCursor`, `LicenseRevocation`), `20260818000003_track_c_affiliate_domain` (full affiliate domain: 10 models + 3 enums), `20260818000004_final_indexes`, `20260818000005_b_l08_license_rls_null_fix`, `20260818170600_affiliate_terms_acceptance`, `20260818170700_affiliate_reserve_release`, `20260819000000_sprint10_license_affiliate_indexes`.

CI applies migrations to PostgreSQL 16 and runs a Prisma migration-diff gate. The scorecard-events migration uses Prisma's PostgreSQL-truncated unique-index name (`...dayBuc_key`); changing it recreates rename-only drift. Production uses `migrate:deploy`; never use `db push` as a deployment mechanism. The `STARTER` enum migration uses `ALTER TYPE ... ADD VALUE` (non-transactional — deployed before code references it).

---

## 6. Environment Contracts

### Product App and Worker

The root `.env.example` is the canonical template. `@lyrashield/config` validates the product runtime at import time.

| Area                    | Variables                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database                | `DATABASE_URL`, optional `DATABASE_DIRECT_URL`                                                                                                                                                   |
| Queue (BullMQ)          | `REDIS_URL` (`redis://` local Docker Redis in dev; managed authenticated Upstash `rediss://` TCP endpoint in production)                                                                         |
| Distributed API limits  | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (HTTPS REST — separate Upstash instance, never interchangeable with `REDIS_URL`)                                                            |
| Better Auth             | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_COOKIE_DOMAIN`, `ADDITIONAL_TRUSTED_ORIGINS`                                                                                               |
| OAuth                   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, optional Google and Azure AD values                                                                                                                  |
| GitHub App              | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`                                                                                                            |
| Public app              | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_MARKETING_URL`, `PORT`                                                                                                                                       |
| Engine                  | `LYRASHIELD_LLM` fallback, `LYRASHIELD_LUNA_LLM`, `LYRASHIELD_TERRA_LLM`, `LLM_API_*`, `LYRASHIELD_IMAGE`, Azure aliases; programmatic tools only after the engine provider-contract gate passes |
| Web Search              | `LYRASHIELD_WEB_SEARCH_ENABLED`, `LYRASHIELD_WEB_SEARCH_API_KEY`, optional `LYRASHIELD_WEB_SEARCH_MODE`, `MAX_RESULTS`, `MAX_CHARS_TOTAL`, `MAX_CALLS_PER_SCAN`, `BUDGET_USD`                    |
| Evidence storage        | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`                                                                                                                        |
| Email/notifications     | `BREVO_API_KEY`, `EMAIL_FROM`, `NOTIFICATION_FROM_EMAIL`, `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL`                                                                                             |
| Billing placeholders    | Polar and Razorpay variables; no billing runtime exists yet                                                                                                                                      |
| Monitoring placeholders | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`                                                                                                                                                           |

Required boot values are `DATABASE_URL`, a 32+ character `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and `NEXT_PUBLIC_APP_URL`. If the Upstash URL is configured, its token is required. GitHub private keys must be PEM-formatted.

The engine runner forwards only an explicit environment allowlist plus recognized provider API-key names. Never pass the full parent process environment to the Python subprocess. Production must pin `LYRASHIELD_IMAGE` by digest.

Next.js page-data collection does not reliably load the root `.env`; export required values or provide `apps/web/.env` for local production builds.

### MCP

`LYRASHIELD_API_URL` selects the product API (default `http://localhost:3000`); `LYRASHIELD_API_KEY` supplies MCP authentication when configured. The MCP server also resolves these from env vars or falls back to reading `~/.lyrashield/credentials.json` (the CLI credentials file, 0o600 perms) so no inline secrets are required. Remote MCP clients (`/api/mcp`) authenticate via hosted OAuth 2.0 with workspace selection and optional write scope, in addition to the existing `lsk_` API-key bearer flow. The MCP server is additionally distributed as a portable Agent Plugin via `@lyrashield/agent-plugin` (Agent Plugins v1.0.0), which packages the server plus skills with a `plugin.json` manifest, `mcp.json`, and `skills/lyrashield/SKILL.md`, and generates client-specific manifest shims for Claude, Cursor, Codex, and Kiro. A complete user-facing API-key issuance lifecycle is still pending. The current tool catalog, supported scan enums, and approval behavior are documented in `userguide.md` §22 and `packages/mcp/README.md`.

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

| Workstream                          | Status                       | Code truth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation/auth/tenancy (0–3 + 2.5) | Core complete                | Better Auth, workspaces, RBAC, onboarding, projects, targets, team, GitHub App, RLS, account deletion/anonymization, scoping, pagination, shared UI.                                                                                                                                                                                                                                                                                                                                                            |
| Agent actions/approvals (3.5/7.5)   | Complete                     | Six actions, signed service tokens, registry permissions, queueing, exact input-hash checks, atomic single-use approvals, approval APIs, RLS model, and controlling-terminal MCP mutation approval.                                                                                                                                                                                                                                                                                                             |
| Scan orchestration (4)              | Complete                     | BullMQ producer/consumer, preflight, guarded lifecycle, bounded phases/shutdown, cancellation/retry, infrastructure exit categories, engine runner, artifact parsing, retry-safe findings/evidence persistence, polling UI.                                                                                                                                                                                                                                                                                     |
| Engine adapter (5)                  | Code complete, release-gated | The controlled derivative and Docker integration pass deterministic gates; an approved production Standard/Luna scan exercised the deployed path. Deep/Terra proof, current image provenance, retained evidence, and production egress remain separate gates.                                                                                                                                                                                                                                                   |
| Normalization/SCA/secrets (6/6.5)   | Complete                     | Source-aware normalizer, verifier, bounded/symlink-safe SCA and secrets discovery, batched/deduplicated OSV requests, explicit non-repository skips, scanner orchestrator, SARIF. Path findings are not discarded by URL placeholder heuristics.                                                                                                                                                                                                                                                                |
| Remediation/output (7–9)            | Complete, PR execution gated | Finding APIs/UI, approval-gated fix proposals, server-owned retests, immutable report snapshots/sharing, aggregate launch readiness, scoped notifications, schedules, URL checks, exact-range diff gate. Fix PR execution deliberately fails closed until a server-generated patch is exact-approval-bound. Evidence uploads are checksum-idempotent.                                                                                                                                                           |
| Scorecards/referrals/distribution   | Complete                     | Versioned scores and immutable snapshots, frozen public scorecards, revocation/supersession, referrals/rewards, premium cards/badges, channel sharing, privacy-safe funnel events, dashboard metrics, waitlist sharing, and report handoff copy.                                                                                                                                                                                                                                                                |
| MCP (9.5)                           | Core complete                | API-backed tools, approval checks, hardened prompt-injection guard (input normalization + expanded pattern set), stdio transport. API-key lifecycle and broader client docs remain.                                                                                                                                                                                                                                                                                                                             |
| Billing/usage (10)                  | Complete                     | `packages/billing` (Polar + Razorpay dual-gateway, 14-day trial, plan-based entitlements, usage metering with agent-minutes and Deep 3× multiplier, minute packs, overage, 15-min grace period, geo-routing), `packages/pricing` (TRIAL/STARTER/PRO/TEAM/AGENCY plans, minute packs, local SKUs), billing routes in `apps/web/src/app/billing/` (checkout, webhook, portal), entitlement gating at scan creation via `assertScanAllowed()`.                                                                     |
| Local/Desktop (BYOK)                | Complete                     | `apps/desktop` (Tauri v2, Rust core + React frontend, ed25519 license verification, OS keychain BYOK credentials, optional cloud sync), `packages/licenses` (signed license sign/verify), license activation/verify/sync endpoints in `apps/web/src/app/api/licenses/` and `apps/web/src/app/api/sync/`, Azure Key Vault integration for production signing, desktop release pipeline (`.github/workflows/release-tauri.yml` — macOS universal + Windows, code signing, notarization, signed updater manifest). |
| Affiliate program                   | Complete                     | `packages/affiliate` (commission engine: 25% recurring Cloud, 30% at 10+ active, 20% one-time Local; attribution: last-click cookie + promo code; fraud controls; payout ledger: RazorpayX/Payoneer), affiliate dashboard at `apps/web/src/app/affiliates/` (landing, apply, dashboard, links, commissions, payouts, activity), webhook dispatch from billing webhook to affiliate commission handlers.                                                                                                         |
| AI safety eval + evidence storage   | Complete                     | `packages/eval-ai-safety` (OWASP Gen AI + MLCommons AILuminate harness), `packages/evidence-storage` (AES-256-GCM envelope encryption, "LSEV1" binary format, fail-closed key management).                                                                                                                                                                                                                                                                                                                      |
| Launch polish (11)                  | Partial                      | UX, accessibility, security hardening, privacy lifecycle, browser E2E, health/readiness, instrumentation, Deep Review v4 remediation, docs, and Docker proof are implemented; controlled scan, authenticated-app/worker infrastructure, egress, and operational monitoring remain.                                                                                                                                                                                                                              |
| Phase 2                             | Not implemented              | Enterprise identity, SCIM, advanced policy, private worker, VPC/self-hosting, and enterprise integrations remain roadmap items. Local/self-hosted models for the BYOK app are deferred (engine requires GPT-5.6 Terra/Luna today).                                                                                                                                                                                                                                                                              |

### Current Verification

- `pnpm lint`: pass
- `pnpm typecheck`: pass across the workspace package graph
- `pnpm test`: pass; current command output is authoritative for suite counts
- `pnpm test:e2e`: pass; covers auth, onboarding, target/scan creation, and cross-tenant scan/finding/report denial
- `pnpm build`: pass for Next.js, worker/agent/MCP TypeScript, and Astro marketing
- `pnpm format:check`: pass
- `pnpm audit --prod --audit-level high`: pass, no known production vulnerabilities
- Prisma validation, fresh replay, drift, deployment, and status: pass for every committed migration
- `git diff --check`: pass
- Engine gate: `scripts/verify-controlled-derivative.sh` passes the bounded footprint, Ruff, formatting, pytest, mypy, Bandit, package/native-binary, sandbox, and public worker-contract checks

### Runtime Truth

- The local Compose architecture includes PostgreSQL, Redis, a migration job, web, and worker. Docker Compose uses the local Redis service for BullMQ (`REDIS_URL`); Upstash env vars are not passed to web/worker containers, so rate limiting falls back to in-memory in dev.
- The current engine-bearing worker image builds and exposes `lyrashield 1.2.0`.
- Missing engine model configuration fails before sandbox pull.
- Historical Docker smoke in §§24–30 proves prior container health, routes, migrations, queue startup, and engine packaging. It does **not** prove a current authorized scan.
- **First approved production Standard scan (2026-07-29):** a Standard (Code Review) scan against `ecryptoguru/OnboardingAI2` completed on the production Azure Container Apps stack using `azure_ai/gpt-5.6-luna` at medium reasoning. Duration 6m 53s, billed cost $1.78, 40 findings (2 CRITICAL, 2 HIGH, 36 MEDIUM), tamper-evident manifest saved. This is a production Standard/Luna scan, not a Deep/Terra scan or security guarantee. A prior attempt failed because two Prisma migrations had not been applied to the production Supabase database — at the time, the Azure deploy workflow did not run Prisma migrations at all. Fixed 2026-07-30: see §59 and the `AGENTS.md` landmine entry; the workflow now runs `prisma migrate deploy` before every container image update.
- Marketing is deployed and indexable at `https://lyrashieldai.com` with production D1/Rate Limit/KV bindings, all D1 migrations, a Worker-secret IP salt, custom apex/`www` domains, an active canonical 301, sitemap/robots/`llms.txt`, security headers, privacy-bounded PostHog capture, and live waitlist/crawl/Lighthouse/Brave QA. The passive `/scan` route is live and indexable behind the separate scanner origin, Turnstile, rate limit, and monitored abuse route. `/terms` remains individually `noindex`. The authenticated app origin is now live in open beta with open registration; app-origin unfurl/referral proof remains an open gate.
- PR #52 merged the social distribution loop; PR #53 merged GPT-5.6 routing/caps; PRs #54–#57 merged Deep Review v3; PR #59 preserved deletion/report compatibility; PR #60 added the premium UI; PR #79 merged Deep Review v4 correctness, worker-truth, UX, database, and PostHog remediation. Each merged implementation PR passes the applicable CI migration, lint, format, typecheck, test, build, Chromium E2E, SCA/secret, and security-diff gates. External social-network cache/unfurl behavior remains a real-domain release check.

---

## 9. API Reference

Most routes live under `apps/web/src/app/api`; public scorecard OG and badge routes live under `apps/web/src/app/(public)/api`. Protected routes use Better Auth plus workspace permission checks. Inputs are Zod-validated at trust boundaries. List endpoints use cursor pagination where applicable.

| Methods            | Path                                | Purpose                                                                                          |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| GET                | `/api/health`                       | Process liveness                                                                                 |
| GET                | `/api/ready`                        | PostgreSQL and Redis readiness                                                                   |
| DELETE             | `/api/account`                      | Confirmed account deletion and anonymization                                                     |
| GET, POST          | `/api/auth/[...all]`                | Better Auth handler                                                                              |
| GET, POST          | `/api/workspaces`                   | List memberships / create workspace                                                              |
| POST               | `/api/workspaces/active`            | Persist active workspace in HttpOnly cookie                                                      |
| GET, PATCH         | `/api/onboarding`                   | Read/update per-user onboarding state                                                            |
| GET, POST          | `/api/projects`                     | Paginated project list / create                                                                  |
| GET, POST          | `/api/targets`                      | Paginated target list / create with SSRF validation                                              |
| POST               | `/api/targets/[id]/scorecard`       | Publish the current eligible score snapshot                                                      |
| GET, POST          | `/api/team`                         | Paginated team list / invite member                                                              |
| GET, POST          | `/api/integrations/github/install`  | Installation callback / signed install URL                                                       |
| GET                | `/api/integrations/github/repos`    | List installation repositories with `installationId`                                             |
| POST               | `/api/webhooks/github`              | Verify and process GitHub deliveries; `installation.deleted` deletes targets by `installationId` |
| GET, POST          | `/api/scans`                        | Paginated scan list / create and enqueue                                                         |
| GET, POST          | `/api/scans/[id]`                   | Scan with events / cancel scan                                                                   |
| GET                | `/api/findings`                     | Paginated finding list                                                                           |
| GET, PATCH         | `/api/findings/[id]`                | Finding detail / update status (`reason` optional)                                               |
| POST               | `/api/findings/[id]/fix-proposals`  | Create fix proposal                                                                              |
| POST               | `/api/findings/[id]/retests`        | Queue retest                                                                                     |
| GET                | `/api/fix-proposals`                | List proposals                                                                                   |
| POST               | `/api/fix-proposals/[id]/create-pr` | Approval-aware GitHub PR creation                                                                |
| GET                | `/api/retests`                      | List retests                                                                                     |
| GET                | `/api/launch-readiness`             | Compute launch-readiness verdict                                                                 |
| GET, POST          | `/api/reports`                      | List / generate report                                                                           |
| GET, POST          | `/api/reports/[id]`                 | Read report / share or revoke token                                                              |
| GET                | `/api/reports/[id]/download`        | Download rendered HTML report                                                                    |
| GET                | `/api/reports/shared/[id]`          | Token-gated public report data                                                                   |
| DELETE             | `/api/scorecards/[id]`              | Revoke a scorecard share                                                                         |
| POST               | `/api/scorecards/events`            | Record allowlisted deduplicated view/share events                                                |
| POST               | `/api/referrals/capture`            | Validate referral/source and set HttpOnly cookies                                                |
| POST               | `/api/referrals/claim`              | Claim a new-account referral during onboarding                                                   |
| GET                | `/api/og/score/[slug]`              | Render grade/fixes PNG in wide/square/portrait                                                   |
| GET                | `/api/badge/score/[slug]`           | Render a script-free revocable SVG badge                                                         |
| GET, POST          | `/api/notifications`                | Paginated list / create notification                                                             |
| PATCH              | `/api/notifications/[id]`           | Update notification read state                                                                   |
| GET, POST          | `/api/schedules`                    | Paginated list / create schedule                                                                 |
| GET, PATCH, DELETE | `/api/schedules/[id]`               | Read/update/delete schedule                                                                      |
| GET                | `/api/agent-approvals`              | List approvals                                                                                   |
| POST               | `/api/agent-approvals/[id]/approve` | Approve exact action input                                                                       |
| POST               | `/api/agent-approvals/[id]/deny`    | Deny pending approval                                                                            |

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
- Repo picker: calls `GET /api/integrations/github/repos` → returns repos with `installationId` for the selected GitHub App installation
- Target creation: calls `POST /api/targets` with selected repo data (type: REPO, provider: github, `installationId`) so the target is bound to the installation
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
- `CreateRepoTargetSchema` — workspaceId, projectId (optional), type: REPO, name, repoProvider (default github), repoOwner, repoName, installationId (optional, stringified GitHub App installation id), branch (optional), environment (default STAGING)
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
- Uses Upstash Redis REST (HTTPS) in production for distributed rate limiting, in-memory Map fallback in dev. `REDIS_URL` is the separate BullMQ connection (`redis://` locally, authenticated `rediss://` TCP in production) and is never used for rate limiting.
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
19. **The engine is a controlled derivative** — explicit `STRIX_*` values win over compatibility variables; LyraShield owns product policy while generic upstream plumbing stays close to the pinned release; stable-release imports remain approval-gated
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
| `packages/integrations/src/queue.ts`                 | Shared getScanQueue/enqueueScan for web and worker                             |
| `packages/integrations/src/redis.ts`                 | Redis connection helper (GitHub token cache, queue)                            |
| `apps/worker/src/schedules.ts`                       | Atomic schedule claims and enqueueing                                          |
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
| `packages/agent-plugin/plugin.json`                  | Agent Plugins v1.0.0 manifest (on `feat/agent-plugin-integration`)             |
| `packages/agent-plugin/mcp.json`                     | MCP server descriptor for the agent plugin                                     |
| `packages/agent-plugin/skills/lyrashield/SKILL.md`   | Packaged LyraShield skill definition                                           |
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
- **GitHub webhook (`api/webhooks/github`)** — idempotent on `X-GitHub-Delivery` (pre-check + P2002 race guard); `installation.deleted` now deletes targets by exact `installationId` stored on `Target`. `Target.installationId` is populated when a repo target is created (from the repo picker's `installationId` or the workspace's active GitHub integration) so uninstallation no longer relies on the coarse `startsWith("{owner}/")` prefix match.
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

- `verbatimModuleSyntax` evaluated — requires `"type": "module"` in all package.json files (breaking change, deferred).
- Root `tsconfig.json` is not orphaned (extended by `packages/config/tsconfig.json` → `library.json` chain); left as-is.

---

## 21. Sprint 4 (Scan Orchestrator + Queue) + Review Fixes (2026-07-05)

### 21.1 Scan Queue (BullMQ)

- **`apps/web/src/lib/queue.ts`** — scan job producer. `enqueueScanJob()` adds jobs to the `scans` queue with default options (3 attempts, exponential backoff, 100 complete / 200 fail retention). Imports `SCAN_QUEUE_NAME` and `ScanJobData` from `@lyrashield/types` (single source of truth).
- **`apps/worker/src/queue.ts`** — worker-side queue utilities. `getScanQueue()` and `enqueueScan()`. Re-exports `SCAN_QUEUE_NAME`, `ScanJobData`, `ScanJobResult` from `@lyrashield/types`.
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
- **`resolveEngineProfile(mode)`** — routes Safe/Quick/Standard to Luna/medium throughout and Deep/Custom to a Terra/medium coordinator with Luna/high specialists; missing routed deployments fall back to `LYRASHIELD_LLM`.
- **`interpretExitCode(code)`** — maps engine exit codes: 0 → COMPLETED (SUCCESS), 2 → COMPLETED (VULNERABILITIES_FOUND), 3 → STOPPED_BUDGET, 4 → RATE_LIMITED, 5 → FAILED, 137 → FAILED (SIGKILL/OOM). Salvaged scans with `engine_stopped` or `content_filter_stopped` terminal reason return 2 (findings present) or 5 (no findings); `run-scan.job.ts` classifies those with findings as `COMPLETED` rather than `FAILED`.
- **`cleanupEngineWorkspace(dir)`** — removes temp workspace (best-effort, non-fatal).
- Focused runner tests cover exit mapping, termination escalation, output discovery, every routing mode, and fallback selection.

### 21.4 Command Builder (`apps/worker/src/engine/command-builder.ts`)

- **`buildEngineCommand(config)`** — constructs CLI args for the scan engine. Maps repository/URL targets to `--target`, maps Safe/Quick to engine `quick`, Standard to `standard`, and Deep/Custom to `deep`, then adds optional `--instruction` and the enforced `--max-budget-usd` value.
- **`resolveScanBudgetUsd(mode, policyMaxBudgetUsd)`** — resolves the canonical repository profile first, then applies $1.20 Safe/Quick, $3.20 Standard, or $5 Deep/Custom. A finite positive workspace policy can lower but never raise that ceiling; explicit zero fails closed and unknown modes are rejected.
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
  3. Error handling: catches all errors, updates scan to FAILED with errorCategory/errorMessage. Salvaged scans (`engine_stopped` or `content_filter_stopped` terminal reason with findings) are classified as `COMPLETED` with `ENGINE_STOPPED` or `CONTENT_FILTER_STOPPED` error category; without findings they remain `FAILED`.
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

- Removed 15 lines of unused worker/shared-package copies from the runner stage. The runner stage is for the web app only (`CMD ["node", "server.js"]`). The worker uses its own dedicated `worker` stage with a vendored TypeScript runner (`CMD ["./apps/worker/node_modules/.bin/tsx", "apps/worker/src/index.ts"]`); it does not invoke Corepack. Docker Compose builds the `migrate` service from the `workspace-builder` stage.

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

**API routes (`apps/web/src/app/api/agent-approvals/`):**

- `route.ts` — GET: list approvals (paginated, status filter, `agent:view` permission).
- `[id]/approve/route.ts` — POST: approve a pending approval (`agent:approve` permission).
- `[id]/deny/route.ts` — POST: deny a pending approval (`agent:approve` permission).

The earlier headless `apps/agent` package has been retired; the same action/approval behavior is now exposed through `apps/web` (agent-approvals API) and `packages/mcp` (MCP tool catalog).

**Tests (16):**

- `packages/db/src/agent-approval-service.test.ts` — 5 tests: deterministic hash, different actions hash differently, different inputs hash differently, verify matching, verify mismatched.
- `packages/auth/src/agent-permissions.test.ts` — 11 tests: permission definitions, all role checks (ADMIN, SECURITY_ADMIN, APPSEC_MANAGER, DEVELOPER, MEMBER, VIEWER, AUDITOR, EXTERNAL_PENTESTER, BILLING_ADMIN), universal view check.

**Other updates:**

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

- **Agent workspace binding** (`apps/web/src/app/api/agent-approvals/*` and `packages/db/src/agent-approval-service.ts`) rejects an approval or action whose `workspaceId` does not match the caller's session or cannot be verified by the workspace-scoped DB service.
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

## §30 — Historical Thin-Fork Automation (superseded, 2026-07-11)

This section records the pre-v1.5.3 architecture. The current engine keeps product behavior outside `strix/**`, permits only two hard-gated upstream seams, and uses `scripts/verify-controlled-derivative.sh`.

> Historical checkpoint. The controlled-derivative ownership and current release-import behavior in §54 supersede this section; the older baseline, test count, and no-auto-merge implementation description remain only as dated provenance.

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

`apps/marketing` is the Astro 7 public site for LyraShield AI. It is built with the `@astrojs/cloudflare` adapter and deployed to Cloudflare Workers. It is separate from the Next.js platform (`apps/web`) and includes its own D1 waitlist/referrals database, Cloudflare Rate Limits binding, and PostHog analytics.

### Stack

- **Framework:** Astro 7 + `@astrojs/cloudflare` (output: `server` / adapter: `cloudflare`)
- **Runtime:** Cloudflare Workers with `workerd` (nodejs_compat enabled)
- **Database:** Cloudflare D1 (`DB` binding), with `0001_waitlist.sql` and `0002_rate_limit_fallback.sql`
- **Rate limiting:** Cloudflare Rate Limits (`WAITLIST_RL` binding) for the waitlist/referral API
- **Styling:** TailwindCSS v4 CSS-first configuration in `src/styles/global.css`
- **Analytics:** `posthog-js` client-side capture
- **Validation:** Zod v4 for waitlist/referral input; `astro:env/server` for `getSecret("WAITLIST_IP_SALT")`
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
- `src/pages/llms.txt.ts` is a dynamic Worker route: it returns 404 for a non-indexable build and generates an LLM-readable summary only for an approved indexable build.

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
- A local Worker smoke passes at `http://localhost:8787`: `/`, `/robots.txt`, and `/sitemap-index.xml` return 200; `/llms.txt` returns 404 in that non-indexable local build.

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

- `apps/worker/src/engine/runner.ts` resolves one engine profile per scan. Safe, Quick, and Standard use `LYRASHIELD_LUNA_LLM` with medium reasoning; Deep and Custom use `LYRASHIELD_TERRA_LLM` with medium reasoning. If the selected variable is empty, `LYRASHIELD_LLM` remains the backward-compatible fallback.
- The resolved model and reasoning effort override only the spawned engine process. Azure credentials, endpoint, and API version continue through the existing generic/Azure allowlist; routing does not duplicate secrets or create separate queues.
- `apps/worker/src/engine/command-builder.ts` resolves the shared repository profile and applies caps of $1.20 for Safe/Quick, $3.20 for Standard, and $5 for Deep/Custom. Unknown modes are rejected. A finite positive `Policy.maxBudgetUsd`, fetched with `workspaceId` and soft-delete scope, can lower but never raise the profile cap.
- `run-scan.job.ts` passes the cap to the engine's `--max-budget-usd` guard and records private accounting events. The `engine_start` event records model and reasoning selection; normalized `llm_usage` remains separately persisted after execution. PR #109 supersedes the original aggregate fallback with the per-request accounting boundary in §51.
- Deep/Custom use a deterministic within-scan route: Terra/medium owns coordination and cross-file judgment while Luna/high runs focused child work. Only the root can create or stop specialists, specialists start without copied parent history unless explicitly requested, stable role-specific prompt-cache keys improve repeated-prefix reuse, and per-request model/cache buckets keep reconciliation exact. Adaptive evidence-triggered promotion, billing-plan quotas, and cross-workspace cost policy remain roadmap work.
- Configuration is propagated through `packages/config`, `turbo.json`, `docker-compose.yml`, `.env.example`, and the deployment runbooks. Regression tests cover every mode, fallback routing, policy overrides, invalid policy budgets, and CLI cap propagation. The full local gate passes 689 Vitest tests in 65 files, lint, typecheck, and production build.

## §35.5 — Parallel Search web_search integration (2026-08-04)

- The engine gained a `web_search` tool backed by Parallel Search (`/v1/search`). `LYRASHIELD_WEB_SEARCH_API_KEY` (Parallel API key) is the primary credential; the engine also accepts `PARALLEL_API_KEY` as a fallback. `packages/config` now models `LYRASHIELD_WEB_SEARCH_ENABLED`, `LYRASHIELD_WEB_SEARCH_API_KEY`, `LYRASHIELD_WEB_SEARCH_MODE`, `LYRASHIELD_WEB_SEARCH_MAX_RESULTS`, `LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL`, `LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN`, and `LYRASHIELD_WEB_SEARCH_BUDGET_USD`.
- `apps/worker/src/engine/runner.ts` forwards the `LYRASHIELD_WEB_SEARCH_*` allowlist to the engine process. `docker-compose.yml` and `.env.example` pass these values to the worker container.
- Production ops: `ops/worker/refresh-secrets.sh` conditionally loads `worker-web-search-api-key` into `LYRASHIELD_WEB_SEARCH_API_KEY`; `ops/worker/refresh-egress.sh` adds `api.parallel.ai:443` to the worker egress allowlist; `ops/worker/run-worker.sh` sets the default `LYRASHIELD_WEB_SEARCH_ENABLED=1` and passes through the tuning variables.
- The engine redacts target hostnames, secrets, IPs, and PII from the query before it reaches Parallel, reserves per-call cost, and enforces `max_calls_per_scan` and a separate `budget_usd`. The tool is available to all scan modes while the product evaluates per-mode gating; no `lyrashieldai` mode gating exists yet.

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

- `packages/security/src/vibe-security-controls.ts` is the executable registry for the 50 researched issue classes. It separates 43 code/URL review controls from 7 evidence-required operational controls, sends applicable controls to the engine as a `coverage_contract` event, and never converts an absent finding into a pass. `docs/vibe-security-50.md` is the human-readable contract.
- The worker adds bounded SCA manifest parsing for Maven/Gradle, agent-instruction checks, CI confused-deputy checks, URL signatures, and normalized coverage reporting. The existing scan detail UI labels the result scope rather than promising all controls were exercised.
- Docker worker hardening keeps Git available for repository clones and reaches the Docker sandbox through its bridge address from inside the worker container. Local Compose intentionally uses the mutable development-only `lyrashieldai-sandbox:local` tag; production workers require a LyraShield-owned immutable digest. The approved production Standard/Luna scan remains target- and version-scoped and does not establish exhaustive coverage.
- `apps/marketing/src/pages/tools/` adds five privacy-first browser-local tools: checklist, pasted-header/CORS review, selected-file secret pattern scan, pasted-SQL RLS lint, and non-production JWT claim inspection. Inputs are deliberately never sent to an API. Chrome browser QA covered tool rendering and JWT, RLS, and headers interactions with a clean console; marketing lint/typecheck/build also pass.
- The dated SEO/AEO/GEO plan contains the 100-topic map and publishing rules. It intentionally keeps editorial work draft-only and rejects a burst of thin pages; the authority article and substantive supporting drafts remain editorial work, not implemented public content.

## §39 — Security-remediation merge (2026-07-14, PR #66)

- The full review's 14 findings are remediated without expanding the trust boundary. `run-scan.job.ts` invokes the external engine only for `REPO` targets; URL targets receive the pinned deterministic scanner and an explicit `engine_skipped` event until the engine supplies an equivalently safe transport.
- `runner.ts` byte-bounds `run.json` and `vulnerabilities.json`. `output-parser.ts` limits findings, text fields, locations, run targets, and usage fields, then preserves only the small schema the worker consumes. Engine-originated evidence is persisted as unverified until independent trusted verification succeeds.
- Scanner-phase abort signals reach SCA filesystem/OSV work, secret discovery, agent-config scans, and safe URL fetches. Safe fetch maintains its timeout through body consumption. The SSRF guard blocks IPv6 site-local `fec0::/10`; scan URLs reject credentials, query strings, and fragments; logs use a redacted origin/path form.
- Agent `CUSTOM` scans now require approval alongside `DEEP`. Notification lists scope a personal feed to the authenticated user plus workspace-wide notices, never a caller-selected user ID.
- `Integration` adds a global `(type, externalId)` unique constraint in migration `20260714170000_integration_global_external_id_unique`. A callback may refresh an already-bound workspace integration but cannot create a new binding without provider ownership evidence. The dashboard exposes a clear blocked state.
- Fix-PR creation no longer accepts client-provided patch/branch/title/body data and returns a truthful conflict until a server-generated, approval-bound patch/evidence pipeline exists. This is a deliberate security boundary, not a claim that automatic PRs are currently available.
- Verification on the branch: `pnpm db:generate`, lint, typecheck, formatting, production build, `git diff --check`, 760 Vitest tests in 74 files, and 2 Chromium E2E tests passed. Applying the new migration and production/browser verification of the blocked-state UX remain deployment gates.

## §40 — Result integrity and evidence-backed retests (2026-07-14–15, PRs #67 and #68)

- Migration `20260714200000_result_integrity_receipts` adds an immutable `ScanResultManifest`, `ScanCoverageReceipt`, privacy-bounded `FindingCandidate`, and idempotent `FindingVerification` receipt. The result manifest records target identity without retaining raw URL content, source-checkout availability, coverage state, and a SHA-256 checksum.
- `apps/worker/src/engine/result-integrity.ts` owns the receipt boundary. Scanner/engine output produces a `DETECTED` candidate and receipt; candidate payloads deliberately omit PoC bodies and source snippets. `apps/worker/src/engine/finding-persister.ts` now treats confidence as triage metadata and always leaves a new claim unverified pending independent proof.
- `FindingCandidate` and `FindingVerification` join `WORKSPACE_SCOPED_MODELS` and receive matching RLS policy pairs in the migration. `ScanResultManifest` and `ScanCoverageReceipt` remain child tables scoped through their `Scan` foreign key, consistent with existing child evidence/event tables.
- A retest API call derives target, goal, mode, and policy only from the server-owned source scan, queues a fresh scan, and ignores a client-selected scan ID. On completion, absence from a fully covered deterministic scanner can mark a finding `VALIDATED` and fixed; engine-only absence is retained as `INCONCLUSIVE`. Neither path sets `verified=true`.
- PR #68 freezes score snapshots after retests are completed. Human/API requests for `FIXED` are stored as `FIXED_PENDING_RETEST`; legacy `FIXED` findings without a `VALIDATED` or `VERIFIED` receipt remain scoreable. This ensures scores and public resolved-findings counts cannot be improved by an unvalidated status change.
- Coverage receipts now aggregate and retain every scanner limitation, reason, and subject in both the receipt and immutable manifest. They are canonicalized for stable checksums. The manifest is written only after findings, retests, and the scan summary are persisted; if a retry finds that checkpoint while the scan is still `VERIFYING`, it resumes only final scoring and does not repeat the billable scan.
- Public scorecard metadata, cards, sharing captions, and accessible image labels use “retest-confirmed” for deterministic validation. They do not describe a retest as independent verification.
- Scan detail, findings, and report snapshots now show manifest/coverage and the explicit detection/validation/verification distinction. Legacy `verified` values are reset by migration because they were confidence-derived rather than backed by retained independent proof.
- Intrusive exploit replay, arbitrary model-generated PoC execution, and server-generated PR patches remain deliberately out of scope until founder authorization, a constrained verifier contract, and production egress controls exist.

## §41 — Evidence-backed release-assurance marketing (2026-07-15, PR #69)

- `apps/marketing/src/pages/index.astro` now leads with the bounded public loop: `Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report`. `apps/marketing/src/pages/methodology.astro` is the corresponding public reference for evidence states, coverage, and non-claims.
- `apps/marketing/src/components/TrustBar.astro`, `HowItWorks.astro`, `ComparisonTable.astro`, `ResultsPreview.astro`, `CoverageMatrix.astro`, `FAQ.astro`, and `Footer.astro` replace universal-verification and automatic-PR framing with scope, provenance, limitations, approval-gated proposals, and truthful retest language.
- The `/tools` hub and its five browser-local utilities remain local-only: supplied text and files are not uploaded or sent to a target. `apps/marketing/src/pages/tools/index.astro` and `ToolCTA.astro` preserve only allowlisted `source=tools|tool` attribution; unknown values revert to `landing` in the waitlist API.
- `apps/marketing/src/components/Header.astro` renders Sign in only when `PUBLIC_APP_URL` is configured, avoiding a broken localhost link in builds without a configured app origin. `apps/marketing/src/components/MarketingPageShell.astro` links the new methodology reference from the global surface.
- `apps/marketing/src/lib/public-claims.test.ts` is the load-bearing public-copy regression suite. It bans claims that every finding is verified, that the product opens a fix PR today, that it scans like an attacker, or that a result is provably gone. PR #69 validation passed the full repository gate: 778 tests in 77 files, 2 Chromium E2E tests, lint, typecheck, build, formatting, Prisma generation, and `git diff --check`.

## §42 — Cloudflare production marketing and Lite Scanner foundation (2026-07-16, PR #71)

- The Astro marketing Worker is deployed at `https://lyrashieldai.com` from the generated `apps/marketing/dist/server/wrangler.json`, with custom apex and `www` domains. Production D1, Cloudflare Rate Limits, KV sessions, and a generated `WAITLIST_IP_SALT` Worker secret are bound; remote migrations `0001_waitlist.sql`, `0002_rate_limit_fallback.sql`, and `0003_waitlist_referrals.sql` are applied.
- Live checks cover HTTPS, canonical metadata, structured data, sitemap/robots/`llms.txt`, the page-scoped `noindex` boundary, defensive response headers, active `www` redirect, and waitlist create/duplicate/position/validation behavior. A synthetic verification row was removed after the test. A live crawl checked 10 sitemap pages and 19 internal URLs with zero broken links. Lighthouse reports 97/100/100/100 on the homepage and 99/100/100/100 on methodology and tools for performance/accessibility/best-practices/SEO.
- `/scan` now fails closed when `PUBLIC_APP_URL` is absent: its controls are disabled, the missing app API is explained, and no target can be sent to localhost or another fallback. The static Docker marketing target proves the exact client artifact, while host Wrangler preview and the live Worker separately prove Worker/D1 behavior.
- PR #71 merged after lint, typecheck, the production build, formatting, `git diff --check`, and 818 tests in 85 files passed locally. PR #72 then assembled realistic fake-key detector fixtures from inert fragments, preserving the load-bearing assertions while restoring both GitHub secret gates. The ready marketing/methodology/browser-local-tools surface is indexable. Remaining gates are the separately protected app API, Turnstile, monitored abuse mailbox, webmaster-account sitemap submission, and app-origin scorecard/unfurl/referral verification.

## §43 — Cloudflare marketing delivery hardening (2026-07-16, PR #74)

- `apps/marketing/src/components/Header.astro` uses a native `details` menu below `sm`, preserving 44 px targets without adding a client runtime. Hero actions are full-width on mobile, stale waitlist errors clear on retry, and footer positioning matches release assurance. Rendered 390×844 QA reached every primary destination with zero horizontal overflow.
- `apps/marketing/src/lib/request-body.ts` streams at most 16 KiB and accepts only JSON or URL-encoded form data. `apps/marketing/src/middleware.ts` applies the static defensive header policy to Worker responses and adds `no-store` plus `noindex` to `/api/*`. Structured waitlist errors retain only the safe error class.
- `.github/workflows/ci.yml` deploys only marketing-impacting pushes to `main` after SCA/secret and full release jobs pass. The pinned Cloudflare action applies remote D1 migrations, deploys `apps/marketing/dist/server/wrangler.json`, and smoke-checks canonical routes, the API boundary, and the `www` redirect. GitHub stores an account-owned deploy token restricted to the minimum Cloudflare permissions required for the marketing deploy, with a recorded expiry (details tracked privately).
- Branch and PR validation passed 822 tests in 86 files, two Chromium E2E tests, lint, typecheck, production builds, formatting, Prisma generation, Docker artifact smoke, Worker-backed D1/API checks, and `git diff --check`. Local Worker Lighthouse scored 99/100/100/100 mobile and 100/100/100/100 desktop.
- Main CI run `29454682106` passed the complete release gate, applied remote D1 migrations, and deployed Worker version `eba63368-9dd4-4dcb-bb0c-09f46c26ec7f` to both custom domains. Independent live checks confirmed the path/query-preserving `www` redirect; 400, 403, 404, 413, and 415 API boundaries; CSP/HSTS/no-store/noindex headers; 10 sitemap pages and 23 internal URLs with zero broken links or metadata/schema issues; and zero console errors. Live homepage Lighthouse scored 91/100/100/100 mobile and 94/100/100/100 desktop, with zero total blocking time.

## §44 — Production Lite Scanner launch (2026-07-16, PR #76)

- Marketing now treats `PUBLIC_SCANNER_URL` as a separate origin from `PUBLIC_APP_URL`. The former enables only the passive Lite Scanner; the latter is now set to `https://app.lyrashieldai.com` to enable open-registration sign-up and sign-in links. Indexable builds require the scanner origin, Turnstile site key, and monitored abuse address together, and `/scan` enters the sitemap only when that gate is complete.
- The Lite Scanner API runs on managed cloud infrastructure with managed TLS, scale-to-zero capacity, managed Postgres with all 18 Prisma migrations applied, managed Redis rate limiting, and Cloudflare Turnstile. Abuse reports route to `abuse@lyrashieldai.com`, a verified monitored destination. (Hosting topology details are tracked privately.)
- Production checks returned healthy database and Redis readiness, correct origin-scoped CORS, and a fail-closed `bot_check_failed` response without Turnstile. Brave completed Turnstile and a real passive scan of `https://lyrashieldai.com`; the rendered result reported five outside-only surface checks as looking OK with explicit non-guarantee language. All five browser-local tools returned 200, the waitlist validation boundary returned 400 for invalid input, and the honeypot returned the normal success shape without inserting a D1 row.
- PR #76 merged as `6e0a225`; main CI run `29464836490` passed lint, formatting, typecheck, 822 Vitest tests in 86 files, two Chromium E2E tests, build, migration drift/application, SCA, secret scanning, Cloudflare deployment, and production smoke checks. This launch does not expose the full BullMQ worker/external-engine scan pipeline. At that checkpoint Deep Review worker correctness remained open; PR #79 later closed the code defects while production worker infrastructure and controlled-scan proof remained separate gates.

## §45 — Deep Review v4 remediation and PostHog completion (2026-07-16, PR #79)

- **Scanner truth:** `apps/worker/src/engine/normalizer.ts` makes false-positive assessment source-aware. URL/host placeholders remain high-risk heuristics for engine/URL results, while SCA, secret, and agent-config file paths are not discarded merely because a directory contains `test`, `example`, or similar text. Regression coverage preserves a real path-based secret finding.
- **Deletion and database integrity:** `packages/db/src/account-deletion.ts` anonymizes `ReferralCode.userId` with a unique row sentinel, matching referral attribution's uniqueness-safe design. Migration `20260716150000_integration_external_id_check` validates positive canonical GitHub installation IDs; `20260716151000_scorecard_share_active_snapshot_unique` resolves legacy duplicates and creates the partial unique active-share index.
- **Worker truth and money:** an engine-reported budget overrun records the usage event, transitions to `STOPPED_BUDGET`, and clamps billable cost to the authorized cap. Active engine processes are registered and terminated during SIGTERM/SIGINT shutdown. Evidence persistence checks finding/checksum identity before upload, preventing retry-created orphan objects. PR #108 added exact decimal cost/token retention; PR #109 later hardened the rate-card boundary and removed accounting from the UI as described in §51.
- **Idempotent sharing and typed workflows:** scorecard publishing takes a transaction-scoped advisory lock per snapshot and reuses the active share across administrators. Approval mutations expose stable `NOT_FOUND`, `NOT_PENDING`, and `EXPIRED` codes rather than requiring API routes to parse error text.
- **Dashboard correctness and UX:** findings return a cursor-backed first page; active scan polling merges refreshed first-page rows without deleting older loaded pages; report share/revoke state uses server responses and clears revoked banners; destructive operations confirm intent. Shared skeletons, title disclosure, mobile targets, keyboard semantics, schedule previews, onboarding state, link fallbacks, light-theme contrast, the Radix finding Sheet, and the shared score visual components close the reviewed UX/accessibility gaps.
- **Marketing and boundary hardening:** preview RSS returns 404 when indexing is disabled; waitlist-position requests use the shared rate limiter; Cloudflare marketing trusts only `cf-connecting-ip`; dynamic/static security headers have a parity regression test. External tool references open separately so browser-local input remains in the original page. PostHog receives an explicit `$pageview` whose `$current_url` contains only origin and pathname; automatic pageview/session recording remain disabled, and the canonical domain is authorized in the production PostHog project.
- **Capacity guardrails:** the worker Compose service has CPU, memory, and PID limits. These are local/runtime safety defaults, not production sandbox isolation proof. Dedicated compute, BullMQ-compatible TLS Redis, the pinned worker/sandbox image boundary, and deployment-level egress control are live; private S3-compatible evidence proof and production capacity evidence remain separate gates.
- PR #79 merged as `98aea48`. Its final branch gate passed 840 Vitest tests in 90 files, two Chromium E2E flows, lint, serial typecheck, production builds, formatting, Prisma generation, migration drift/application across 20 migrations, SCA/secret scanning, the security diff gate, CodeRabbit review, Docker Compose validation, and `git diff --check`. Main CI run `29487616647` repeated the release gate, applied the marketing D1 migration check, passed production smoke checks, and deployed Cloudflare Worker version `31514039-473b-4837-95cf-d61da009e238`.

## §46 — Homepage Lite Check funnel and marketing navigation cleanup (2026-07-16, PR #84)

- `apps/marketing/src/components/landing/HomeLiteScan.astro` places the live passive Lite Check immediately below the homepage hero. The primary hero, header, and footer actions route to the form; product-updates signup remains the secondary product action.
- The form keeps the scanner trust boundary intact: `PUBLIC_SCANNER_URL` still controls availability, authorization and Terms acceptance are required, embedded-credential URLs fail inline, and the target crosses to `/scan?start=1` through session storage rather than appearing in query parameters. The existing `/scan` route remains the only Turnstile/API/results implementation and auto-starts only after a token is available.
- Visible breadcrumb navigation is removed from the scanner, methodology, tools hub and detail layouts, resources, article layout, sample report, and Terms. Their existing `BreadcrumbList` JSON-LD remains unchanged, and a regression test locks the metadata-only presentation.
- Desktop 1440×1000 and mobile 390×844 browser QA covered hero-to-form scroll, native validation, authorization, responsive layout, target handoff, scan-page prefill, and the absence of visible breadcrumbs. The final branch gate passed the production dependency audit, Prisma generation, lint, formatting, typecheck, 841 Vitest tests in 90 files, every production build, two Chromium E2E flows, and `git diff --check`.

## §47 — Scan progress and future-product preview (2026-07-16, PR #85)

- `apps/marketing/src/pages/scan.astro` replaces the timed checkmark log with an animated public-surface map and five rotating review categories. The cycle communicates current activity without claiming streamed phase completion or a percentage, scrolls into view when a scan begins, sets `aria-busy`, uses one stable screen-reader status announcement, and stops motion under `prefers-reduced-motion`.
- `apps/marketing/src/components/landing/AssuranceRecord.astro` expands the homepage product story into one illustrative evidence ledger with target/mode/report/retest context, explicit detected/verified/retest-confirmed/inconclusive states, the truthful 43 code/URL review plus 7 evidence-required Vibe Security 50 registry split, and links to the sample report and methodology. Sample counts are visibly labeled as illustrative rather than production performance.
- Desktop 1280×720 and mobile 390×844 Browser/IAB QA covered copy, typography, brand palette, layout, responsive workflow wrapping, scan motion, reduced-motion emulation, live handoff behavior, and horizontal overflow. The final branch gate passed the production dependency audit, Prisma generation, lint, formatting, typecheck, 843 Vitest tests in 90 files, every production build, two Chromium E2E flows, and `git diff --check`.

## §48 — Direct scan URLs and one-pass progress (2026-07-16, PR #86)

- `apps/marketing/src/pages/scan.astro` now uses a URL-keyboard text field so native URL validation does not reject a bare domain before the existing normalizer can add HTTPS. The homepage form exposes the same example; complete HTTP(S) URLs retain their supplied scheme.
- The scan activity controller replaces its repeating interval with one cancelable timeout sequence. Each of the five rows receives one 800 ms turn; successful fast responses await the sequence, slow responses hold on row five, error cleanup cancels it, and reduced-motion results remain immediate.
- `apps/marketing/src/tests/lite-scan.test.ts` locks the bare-domain contract, the non-repeating sequence, and the result wait. Instrumented desktop Browser QA observed the exact five-row order and successful result transition; 390×844 QA found no overflow or framework overlay. The full gate passed Prisma generation, lint, formatting, typecheck, 844 Vitest tests in 90 files, every production build, two Chromium E2E flows, and `git diff --check`.

## §49 — Authority blog and premium assurance world production release (2026-07-17, PR #88)

- `apps/marketing/src/content/blog-program.json` maps the planned 100-article program across seven releases: the authority guide followed by six batches. Release briefs, claim-to-source research records, image manifests, the canonical image catalog, and MDX frontmatter form one validation boundary. The public editorial policy is intentionally outside the 100-article count.
- The program plans a 36-image source-artwork library: one exclusive authority image plus 35 deliberately reused images. Creative masters stay ignored under `apps/marketing-motion`; only cataloged web derivatives may enter the marketing package. Image IDs own canonical metadata, crop intent, source hashes, and reuse counts.
- `apps/marketing/scripts/crawl-built-blog.mjs` exposes dependency-free inspection and validation helpers plus a local Worker CLI. It recursively reads the generated sitemap, compares exact mapped article paths, checks blog and tag pages, verifies status codes, unique canonicals, title/description, one H1 and main landmark, internal anchors, image availability, JSON-LD parsing, RSS membership, and draft exclusion, and removes query strings and fragments from reports.
- `apps/marketing/src/tests/blog-built-crawler.test.ts` locks crawler success, malformed-page failures, missing JSON-LD and article-image failures, recursive sitemap discovery, and query-free reporting. Its five focused tests pass. `apps/marketing/src/tests/blog-program-complete.test.ts` requires exactly 100 mapped published articles and must pass before the release candidate is presented locally.
- `apps/marketing/BLOG_AUTHORING.md` records the exact brief, research, source, Humanizer, image, correction, stable-anchor, approval, local-preview, and publication workflow. `apps/marketing/README.md` records the Worker-backed local crawl and preserves the deployment boundary.
- PR #88 merged after green CI and the guarded marketing workflow deployed the complete program. The live sitemap, homepage manifest, R2 media delivery, CSP, exact-origin CORS, immutable cache headers, and the retired `/premium-preview` 404 were verified. The canonical homepage now uses the seven-chapter premium assurance world; all 100 mapped entries are live and indexable.

## §50 — Production assurance-world motion hardening (2026-07-17, PR #91)

- `apps/marketing/src/components/landing/EvidenceWorld.astro` now owns an abort-safe two-slot media pipeline: MP4-first/WebM-fallback blob fetches, decoded-frame gating through `loadeddata`/`HAVE_CURRENT_DATA`, exclusive foreground ownership, current-plus-next retention, URL revocation, and poster fallback on network, CORS, decode, or memory failure.
- Scroll updates remain one passive listener plus `requestAnimationFrame`. Seeks are coalesced, skipped while `video.seeking`, resumed from `seeked`, and eased toward the latest target. Width changes rebuild the desktop/portrait pair; height-only mobile browser-chrome changes update geometry without refetching media.
- The enhanced layout keeps only the active semantic chapter visible and centers its copy inside the pinned cinematic viewport. The world releases fixed positioning on exit. Reduced-motion and Save-Data load no video, while no-JavaScript output exposes all seven readable chapters.
- `apps/marketing/src/tests/premium-preview.test.ts` locks the seek guard, `seeked` continuation, decoded-frame threshold, exclusive foreground class, width-only resize guard, and active-chapter contract. PR #91 and main run `29569931969` passed security/SCA, migrations, lint, formatting, typecheck, 910 repository/marketing/motion tests, builds, and Chromium E2E before Cloudflare deployment and production smoke checks.
- Live QA at 1440×900 and 390×780/844 verified native 1600×900 and 720×1280 assets, normal/rapid/reverse scrolling, one readable chapter, mobile resize source stability, no horizontal overflow, poster-only reduced motion, complete no-JavaScript content, clean cinematic exit, and zero browser console errors. The immutable HyperFrames/Three.js render `14cdcb1b53692d73` remained unchanged; no Higgsfield is part of the production pipeline.

## §51 — Per-request GPT-5.6 accounting and cost-free dashboard (2026-07-18, PR #109)

- `apps/worker/src/engine/output-parser.ts` prefers bounded root usage counters and normalizes up to 10,000 request-usage entries into standard and long-context input, cached-read, cache-write, and output buckets. Prompts, responses, and raw provider payloads are not persisted.
- `apps/worker/src/engine/gpt56-pricing.ts` versions the official GPT-5.6 Terra/Luna base rates and applies the greater-than-272,000-input-token multipliers to the entire affected request. Aggregate input above that threshold is deliberately not priced because an aggregate cannot identify which request crossed it.
- `run-scan.job.ts` records the calculation method and reconciliation status privately, retains engine-reported telemetry separately from the official rate-card calculation, and uses the higher known amount only for conservative limit enforcement. This ledger is operational telemetry, not an Azure invoice; provider billing remains the final expenditure source.
- The Next.js dashboard removes monthly spend, scan cost cards, preset amounts, schedule amounts, accounting-event rows, and cost-bearing failure text. Users still see model/reasoning, coverage, findings, evidence state, and neutral protected-limit messages.
- The merged PR passed 858 core tests in 94 files, 79 marketing tests, 16 motion tests, two Chromium E2E tests, lint, typecheck, production build, formatting, migration drift/application, SCA/secrets, the security diff gate, CodeRabbit, and `git diff --check`.
- Engine PR #6 merged before the coordinated hardening release. It adds estimated-input compaction at 240k toward 180k and bounds direct dedupe input to 200 kB; engine PR #7 retains and extends those limits as described in §52.

## §52 — GPT-5.6-only AI-pipeline and evidence hardening (2026-07-18, app PR #113; engine PR #7)

- The engine accepts only GPT-5.6 Terra or Luna deployment names. The inherited Perplexity/web-search tool, credentials, renderer, skills, and documentation are removed; the worker forwards only the bounded OpenAI/Azure credential surface. Parallel is not configured because no current repository-scan phase requires external research.
- Prompt rendering fails closed. Context compaction preserves complete tool-call/output groups, output tokens and total agents are mode-bounded, caller-supplied coordinators are capped, and a concurrency-safe pre-request reservation prevents aggregate spend from exceeding the approved limit. Non-interactive execution bypasses Rich live rendering, suppresses target-derived exception output, and retains stable run names plus model/reasoning/prompt-bundle reproducibility metadata.
- Engine report deduplication uses deterministic dependency and dynamic identities rather than a second model call. Reporting carries validated Vibe Security control IDs, structured dependency data, evidence, assumptions, fix effort, and CVSS breakdown without allowing model confidence to become verification proof.
- The worker persists usage immediately after engine execution, before downstream scanners can fail or cancel. It retains separate engine-reported and rate-card reconciliation, rejects incomplete cache-write pricing, does not persist raw stdout/stderr, bounds progress heartbeats, and deletes only validated worker/engine-owned paths.
- Finding fingerprints preserve distinct package/CVE and code-location claims while correlating exact duplicates across detectors. Candidate hashes bind the bounded claim context; every corroborating detector receives its own detection/verification receipt; explicit control IDs own engine coverage; and unmatched model-only controls remain blocked/inconclusive rather than clean.
- Docker verification caught and removed stale deleted-tool bytecode from the engine build context. The merged application gate passes 869 core tests, 79 marketing tests, 16 motion tests, and two Chromium E2E tests. The merged engine gate passes 597 tests (1 skipped), Ruff, formatting, headless mypy, Bandit, package/native-binary checks, sandbox build/smoke, worker compatibility, and a rebuilt worker-image smoke for GPT-5.6 policy and Perplexity absence. No paid model scan was used for this verification.

## §53 — Fail-closed scan admission and queue recovery (2026-07-18, PR #115)

- `packages/integrations/src/queue.ts` owns a Redis sorted-set registry for multiple worker replicas. A worker registers only after BullMQ readiness, refreshes every 10 seconds with a 30-second expiry, and removes only its own registration during graceful shutdown. Central `enqueueScan()` checks the registry immediately before BullMQ submission.
- Manual scans, server-owned retests, schedules, and agent actions check availability before creating a scan and share the `503 SCAN_SERVICE_UNAVAILABLE` contract. If availability changes during enqueue, the created scan transitions through `updateScanStatus()` to `FAILED` with retained queue-failure history rather than remaining queued.
- `apps/worker/src/queue-reconciliation.ts` runs at startup and every 60 seconds under a renewable token-owned Redis lease on a dedicated connection. A `QUEUED` scan older than five minutes without a processable job becomes `FAILED` with `QUEUE_ORPHANED`; waiting, delayed, prioritized, or paused jobs whose scan is missing or terminal are removed. The reconciler never creates or requeues a job, so recovery cannot silently repeat GPT-5.6 usage.
- `/api/ready` remains the web dependency gate. `/api/ready/scans` independently returns 503 without a live worker heartbeat. Compose uses a worker-local marker refreshed only after successful Redis heartbeats, avoiding a circular web health dependency while external monitoring retains the scan-specific endpoint.
- The E2E critical flow no longer submits a real scan. Teardown tracks marker-owned users/workspaces/targets and respects the database soft-delete/audit boundary even after partial failure. The 17 confirmed historical fixtures were changed from `QUEUED` to `CANCELLED`, soft-deleted with explicit cleanup events, and removed from active membership/user fixtures; unrelated records were not selected.
- Before rebuilding Docker, the database had zero active queued scans and zero enabled schedules, and BullMQ had zero waiting, delayed, prioritized, or active jobs. After the merged worker started, web and scan readiness returned ready, the worker-local healthcheck passed, logs showed clean startup, and all four counts remained zero. No model or provider request was made.
- PR #115 passed migration drift/application, lint, formatting, typecheck, 881 core tests in 97 files, 79 marketing tests, 16 motion tests, production builds, two Chromium E2E tests, SCA/secret scanning, the repository diff gate, CodeRabbit, the LyraShield action, Docker Compose validation, worker-image build, and `git diff --check`.

## §54 — Engine ownership and compatibility boundary (2026-07-18)

- The engine repository is a controlled derivative, not a thin wrapper. Version 1.2.0 keeps product behavior in `lyrashield/**` and `lyrashield_adapter/**`; `strix/**` differs from pinned Strix v1.5.3 (`7cc9fa9faa0179fc7e35111102fe3d20a9028393`) only at two generic registration seams (+24/−0). `scripts/verify-controlled-derivative.sh` rejects any unlisted upstream drift or footprint increase beyond that budget. See the engine repo's `UPGRADES.md` for the ownership ledger.
- LyraShield owns GPT-5.6 acceptance, mode/reasoning policy, context compaction, output/agent/pre-request spend limits, non-interactive lifecycle, deterministic finding identity, structured control/evidence metadata, telemetry defaults, and the versioned worker-facing artifact contract.
- The pinned Strix v1.5.3 tree remains the substrate for sandbox/session mechanics, generic tools, agent-SDK plumbing, and the vulnerability skill library. Stable-release imports remain review-gated; no independent rewrite is justified without repeated upstream blockers or evaluation evidence.
- The target architecture is evolutionary: move LyraShield-owned policy behind explicit engine modules and a versioned JSON protocol when touching those paths, while preserving child-process isolation. Do not create a second runtime or speculative abstraction solely to make the repository look independent.
- Result quality is not established by the inherited Strix v0.4 XBEN result. Before changing orchestration or making accuracy/coverage claims, add a private LyraShield corpus with expected findings and expected non-findings, evidence correctness, duplicate stability, control coverage, runtime, and token-use measurements for Luna and Terra.
- Reconsider full independence only when upstream repeatedly blocks required product behavior, reviewed release imports become materially more expensive than ownership, or the LyraShield evaluation suite demonstrates a substrate-imposed result ceiling.

## §55 — Engine PR #20 and finding statusReason (2026-07-25)

- **Historical Engine PR #20 checkpoint:** the former in-tree implementation added GPT-5.6 rate and usage-extraction fixes. The v1.5.3 product-outside-Strix migration moved product behavior into `lyrashield/**`; the current gate is `scripts/verify-controlled-derivative.sh`, and its command output—not this dated checkpoint—is authoritative.
- **Finding statusReason:** `Finding` gained an optional `statusReason` column (migration `20260725132208_add_finding_status_reason`). `packages/db/src/finding-service.ts` accepts an optional `reason` on `updateFindingStatus`, `acceptRisk`, and `markFalsePositive`. `apps/web/src/app/api/findings/[id]/route.ts` validates an optional `reason` field in the PATCH schema and passes it to the DB. The findings client (`apps/web/src/app/(dashboard)/dashboard/findings/findings-client.tsx`) sends the collected comment and renders `statusReason` in the detail drawer. Unit tests in `packages/db/src/finding-service.test.ts` cover the reason persistence path.
- **Worker hardening:** `apps/worker/src/jobs/run-scan.job.ts` adds a single-model cost fallback for mixed-model usage, post-engine cancellation check, and target field projection before preflight. `apps/worker/src/engine/finding-persister.ts` recovers from unique-constraint races during finding creation by updating the recovered row.
- **Dashboard UX:** the scans list (`apps/web/src/app/(dashboard)/dashboard/scans/scans-client.tsx`) uses adaptive polling backoff and `visibilitychange` handling. Findings list syncs filter/sort with URL query params. `api-keys.tsx` uses a shared clipboard helper and surfaces copy errors. `inline-confirm.tsx` restores focus after confirm/cancel.
- **API hardening:** `apps/web/src/app/api/scans/[id]/route.ts` returns an ETag based on scan status/events and respects `If-None-Match`. Scorecard create/revoke routes enforce write scope for API keys. `apps/web/src/lib/api-client.ts` adds `apiGetConditional` for ETag-aware conditional GETs with timeouts.
- **Verification:** the merged `main` passes `pnpm lint`, `pnpm typecheck`, `pnpm test` (1357 core tests in 138 files, 82 marketing tests, 16 motion tests), `pnpm build`, `git diff --check`, and 30 applied Prisma migrations.

## §56 — Azure Foundry capability boundary and worker usage resilience

- The configured Azure Foundry GPT-5.6 endpoint accepts baseline Responses requests and `previous_response_id`, but rejects the `programmatic_tool_calling` tool type. Repository scans therefore retain direct JSON function tools. The engine exposes programmatic calling only behind `LYRASHIELD_PROGRAMMATIC_TOOL_CALLING=1`; operators must leave it unset unless `lyrashield provider-contract --require-programmatic-tool-calling` succeeds against the exact deployment.
- Server-managed continuation is not an engine feature yet. `Runner.run_streamed` rejects `previous_response_id` while its SQLite session is supplied, and SQLite sessions remain required for resume and multi-turn engine state. Replacing that state with a server-managed conversation is a separate design change, not a configuration switch.
- `apps/worker/src/engine/output-parser.ts` now records zero values for optional standard-request cache-read/cache-write buckets when the provider omits them. `apps/worker/src/engine/runner.ts` omits empty allowlisted environment variables. Together these preserve conservative accounting and prevent an empty routed setting from changing provider fallback behavior.

## §57 — UX V2 Phases 0–10 (2026-07-29)

- UX V2 Phases 0–10 are merged on `main`. The dashboard now has a mobile-first shell (`V2Sidebar`, `BottomNav`, `MobilePageHeader`), a feature-flags system with env and per-workspace cookie override, a PostHog product analytics wrapper with privacy-safe allowlist, and a terminology mapping module (`apps/web/src/lib/terminology.ts`) that maps internal identifiers to user-facing labels (Scan→Trust Run, Finding→Issue, Project→Product, Target→Asset).
- New schema additions via migration `20260803000000_uxv2_schema`: `Project.trustPlan`, `NotificationPreference`, `Scan.durationMs`. The `NotificationPreference.updatedAt` field is aligned with its migration via `@default(now())`.
- New V2 route aliases (not renames): `/dashboard/products` (targets), `/dashboard/runs` (scans), `/dashboard/issues` (findings), `/dashboard/approvals`, `/dashboard/evidence` (reports), `/dashboard/automations` (schedules). Legacy URLs remain canonical with `next.config` rewrites or 308 redirects.
- The dashboard home renders a `TrustCommandCenter` using workspace project trust-plan data, completed scan count, and latest score. Evidence and Approvals pages are functional. Notification preferences UI is live. A share sheet with privacy-safe channels is implemented.
- The worker schema accepts engine `run.json` progress fields (`phase`, `seq`, `turn_count`) via `engineRunRecordSchema`.
- Onboarding state creation is race-free via raw `INSERT ... ON CONFLICT DO NOTHING` in `apps/web/src/lib/onboarding-state.ts`, replacing the Prisma `upsert` that could surface P2002/23505 under concurrent server-component and API calls.
- Playwright visual baseline snapshots exist for dashboard, products, runs, issues, and onboarding at desktop, iPad, and iPhone viewports. Visual E2E tests are skipped in CI (`--grep-invert '@visual'`) until Linux baselines are generated; the 3 Chromium E2E critical-flow tests remain in CI.
- The marketing homepage includes a V2 launch highlight section.
- The merged `main` passes 1357 core tests in 138 files, 82 marketing tests in 12 files, 16 motion tests, 3 Chromium E2E tests, lint, typecheck, production build, formatting, 30 applied Prisma migrations, SCA/secret scanning, and `git diff --check`.

## §58 — UX V2 polish batch (2026-07-29)

- **Mobile safe-area and navigation:** `viewport-fit=cover` added to `apps/web/src/app/layout.tsx` viewport metadata; `apps/web/src/components/mobile-page-header.tsx` respects `env(safe-area-inset-top)` and renders an accessible back button with `ChevronLeft` icon and `buttonVariants` styling; `apps/web/src/app/(dashboard)/layout.tsx` main content top padding matches the increased header height.
- **Bottom sheet animations (superseded by §59):** `bottom-sheet.tsx` originally gained enter/exit transitions here; it was deleted in the §59 batch in favor of the Radix `Sheet` already used elsewhere, which provides focus trap, Escape-to-close, and scroll lock that the custom component lacked.
- **Shared label module (superseded by §59):** the label module lives at `apps/web/src/lib/labels.ts` (not `enum-labels.ts` — that path was never created). It originally held only `GOAL_OPTIONS`; §59 extended it into the single place raw enums become readable text.
- **Ownership attestation:** `packages/types/src/index.ts` `CreateUrlTargetSchema` now requires `ownershipAttested: true`. `apps/web/src/app/api/targets/route.ts` rejects creation without it and writes a distinct `target.ownership_attested` audit entry. `apps/web/src/app/(dashboard)/dashboard/targets/targets-client.tsx` includes a required checkbox.
- **Release verdict documentation:** `apps/marketing/src/pages/methodology.astro` documents the release verdict scale: Go (≥80), Go with conditions (40–79), No go (<40), and Not evaluated.
- **Trust Command Center:** `apps/web/src/components/trust-command-center.tsx` derives mode from the latest scan or trust plan instead of a hardcoded `"SAFE"`.
- **Finding detail drawer:** retry and close actions are available on API error instead of a dead-end.
- **Retest tooltip:** the disabled "Queue fresh retest" button explains what a linked scan is and how to get one.
- **Manual refresh:** the in-progress scan detail view supports manual refresh with ETag clearing.
- **Parallel queries:** `apps/web/src/app/(dashboard)/dashboard/issues/page.tsx` and `products/page.tsx` use `Promise.all` for parallel database queries.
- **Font preload:** the Bricolage Grotesque hero typeface import is centralized in `apps/marketing/src/styles/global.css`.
- **EvidenceWorld lazy island:** verified the IntersectionObserver-based lazy load with `rootMargin: "50% 0px"` and dynamic import in `apps/marketing/src/components/landing/EvidenceWorld.astro`.
- **Skeleton radius:** loading skeletons use `rounded-lg` to match card radius across findings, scans, reports, and targets loading states.
- **Bound queries:** `apps/web/src/app/(dashboard)/dashboard/runs/page.tsx` bounds `target.findMany` with `take: 200`.
- **Evidence/approvals pages:** use lean `select` projections for database queries.

## §59 — UX V2 audit remediation, spend controls, and RLS proof (2026-07-30, branch `fix/uxv2-sweep-p0`)

A three-round post-ship audit (mobile nav, live production, and a full local build/test verification) found and fixed defects the §57/§58 merge shipped with. Every item below was verified by execution against a real cloned repo with dependencies installed — not inferred from a diff — including a full local Postgres run of the entire suite (118 files, 1055 tests, 0 skips) with the production migration chain applied.

**P0s live in production before this batch:**

- **Mobile nav orphaned three destinations.** `bottom-nav.tsx` rendered `PRIMARY_NAV_ITEMS.slice(0, 4)` against seven `primary` items; the three that fell off the end (Approvals, Evidence, Automations) were not in the `mobileMore` list either, so they had no mobile navigation path at all. Fixed by replacing the two overlapping flags with one `mobilePrimary` marker and deriving `MORE_NAV_ITEMS` as its exact complement (`apps/web/src/lib/nav-items.ts`). `nav-items.test.ts` asserts the complement property so a newly added destination cannot be silently dropped again.
- **Every pre-verdict public scorecard returned a 500.** `ScorecardShare.publicPayload` is frozen at share creation; shares predating `releaseVerdict`/`verdictVersion` lacked both fields, and `getPublicScorecard` blind-cast the stored JSON before the page indexed `verdictConfig[undefined]`. Fixed with `normalizeScorecardPayload()` in `packages/db/src/score-service.ts`, which fills only fields added after the first shares went out, never widens disclosure, never infers a verdict from the grade, and fails closed to `null` (404) when a field that has always been present is missing or malformed.
- **The marketing deploy was stranded.** `deploy-marketing` in `.github/workflows/ci.yml` only ran when the single push diff touched `apps/marketing`; a push that failed CI while carrying a marketing fix caused every later CI-fixing push (that didn't touch marketing) to also skip the deploy. Removed the path filter and added a step that greps the live homepage for markers unique to the current build, so a skipped or cache-pinned deploy fails the workflow instead of passing silently.

**Empty-state dead ends (17 of 25 call sites):** `EmptyState.action` in `packages/ui/src/empty-state.tsx` is now typed `React.ReactNode | null` (required, not optional), so omitting it is a typecheck failure. Ten duplicated "No workspace yet" states with no way forward were replaced by one `apps/web/src/components/no-workspace-state.tsx`. The remaining states got a real action (start a review, review issues, new schedule, add a product) or an explicit `action={null}` where nothing is actionable (no notifications, a clean scan result, no events yet).

**Icons that read as noise, not a rendering bug:** the "stray glyph" reported across three review rounds was a `Play` (media) icon on "Create workspace" and a `SkipForward` icon on "Finish later" — both rendered correctly, they were simply media-player icons on non-media actions. Replaced with `Plus` and `Clock`. `Play` is kept only where it means "start a run."

**Raw database enums shown to users:** severity badges, evidence-type labels, and the target scan-history table rendered schema values verbatim (`CRITICAL`, `LOG_SNIPPET`, `DEEP`). `apps/web/src/lib/labels.ts` — previously holding only `GOAL_OPTIONS` — now also exports exhaustive `Record<Enum, string>` maps for `ScanMode`, `FindingSeverity`, and `FindingStatus` (typed against `@lyrashield/types`, so a new enum value without a label is a typecheck failure), plus a `humanizeToken()` fallback and known-value maps for the free-form `Evidence.type` and `Scan.triggerType` string columns. The duplicated, drifted `GOAL_LABELS` map in `scans-client.tsx` was deleted in favor of `getGoalLabel()`.

**Mobile header and command-center copy:** `MobilePageHeader` previously hardcoded `title="LyraShield"`, spending the one place a phone screen can be named on the brand; it now derives the title from `NAV_ITEMS` by longest-matching route and renders the brand as a small mark instead, with a working notifications link where a dead `Button` used to be. `TrustCommandCenter` no longer defaults a missing scan history to `"SAFE"` for display — `mode` is `string | null`, and the "in ___ mode" clause is omitted entirely when nothing has run yet (the duration _estimate_ still defaults internally, since that default is arithmetic, not a claim about a past scan). The tamper-evident record card reads "Sealed" / "Sealing…" / "Not sealed" instead of a bare "Pending" that read like a failure.

**One sheet implementation instead of two:** `bottom-sheet.tsx` was hand-rolled and had no Escape handler, no focus trap, no focus restoration, no body scroll lock, and put `role="dialog"` on the backdrop rather than the panel. Deleted; its only consumer (`share-sheet.tsx`) now uses the Radix `Sheet` already used by `BottomNav`'s More menu.

**Manual refresh on in-progress runs:** polling backs off to 60s and pauses while the tab is hidden, so a long review could look stalled with no way to ask for an update. `scan-in-progress.tsx` gained an optional `onRefresh`/`refreshing` pair wired to the parent's existing `handleManualRefresh` (which already owned the `AbortController` and refreshing state).

**Desktop sidebar grouping:** `v2-sidebar.tsx` rendered all 11 `NAV_ITEMS` as flat peers though the nav model already encodes a primary/secondary split; it now renders `PRIMARY_NAV_ITEMS` and `SECONDARY_NAV_ITEMS` (the latter under a "Workspace" heading) through one shared `SidebarLink`.

**Spend and rate-limit controls (`apps/web/src/lib/rate-limit.ts`, `apps/web/src/app/api/scans/route.ts`):** scan creation was governed only by the general 30/min per-IP API limit plus a per-target "one active scan" guard — nothing bounded a workspace fanning out across many targets, and each scan can commit up to `PLATFORM_MAX_SCAN_BUDGET_USD`. Added `checkScanCreateRateLimit` (5 scan starts per workspace per minute, keyed on workspace so rotating IPs don't lift it, returns 429 with `Retry-After`) and a `MAX_CONCURRENT_WORKSPACE_SCANS = 3` concurrency cap checked in the same `Promise.all` as the existing per-target guard. `apiError()` in `apps/web/src/lib/api-response.ts` gained an optional fourth `headers` argument (additive) to carry `Retry-After`.

**RLS proof, and a corrected earlier finding.** A prior review flagged `project_rls_permissive` (from the superseded `20260705100000_batch3_rls` migration) as "the most serious finding" — that finding was stale: `20260721033000_strict_workspace_rls` already dropped all 21 permissive policies and applied `FORCE ROW LEVEL SECURITY` in a migration that predates this batch. What was missing was execution-level proof — the existing suite asserted policy coverage by inspection only. `packages/db/src/rls-fail-closed.test.ts` now runs real queries through `RLS_RUNTIME_DATABASE_URL` (the `NOBYPASSRLS` role CI already provisions for the `Lint, Typecheck, Test & Build` job) and **fails outright rather than passing vacuously** if handed a role with `rolsuper` or `rolbypassrls` true — running it as a superuser was the first version's actual bug, since Postgres superusers bypass RLS unconditionally and `FORCE ROW LEVEL SECURITY` only binds the table _owner_, never a superuser. Verified locally with a real Postgres and the full migration chain applied: under a genuine `NOBYPASSRLS` role, no-context and cross-workspace reads/writes all return zero rows.

**Email verification is now real, and deliberately still off.** `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION` was declared in `packages/config/src/env.ts` and read by no code at all, so setting it had zero effect; actual behavior derived solely from whether `BREVO_API_KEY` happened to be set. `packages/auth/src/auth.ts` now derives `emailVerificationEnabled` from both the flag and the provider, and boot-time validation (`packages/config/src/env.ts`) refuses to start in production when verification is requested without a provider — with a message naming both ways out. The schema default flipped to `"1"`; production keeps it explicitly `"0"` in `.env.example` and as a repository variable read by `deploy-azure.yml`, recorded as an accepted, documented blocker (see `docs/deployment/PRODUCTION_DEPLOYMENT.md` "Known production blockers" §1) rather than a silent gap.

**Shared rate-limiting credentials are a deploy gate, not a boot gate.** The first version of this requirement lived in `packages/config/src/env.ts`'s boot validation and broke the Playwright E2E web server in CI, because boot validation fires in _every_ production-mode process, not only a real deployment, and would fail a running app on restart — trading a rate-limiting weakness for an availability outage. Moved to `deploy-azure.yml`: `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are asserted before the container image swap and passed to both container apps as secret references, mirroring the `DATABASE_DIRECT_URL` migration guard added in the same PR.

**Deploy pipeline hardening (`.github/workflows/deploy-azure.yml`):** the workflow previously ran no database migrations at all — they existed only in CI against a throwaway database — so a schema-dependent release served 500s in production until someone ran `prisma migrate deploy` by hand (this is the exact failure `AGENTS.md`'s prior landmine entry described for the 2026-07-29 `Finding.statusReason` incident). Migrations now run via `pnpm --filter @lyrashield/db exec prisma migrate deploy` immediately before the container image update, using `secrets.DATABASE_DIRECT_URL`, and the step fails loudly if that secret is unset rather than deploying against an unmigrated schema. Both health smoke checks were pointed at `/api/health` (a static `{ status: "ok" }` that would pass with Postgres down); they now probe `/api/ready`, which checks the database and Redis. `.github/workflows/production-backup.yml` moved from `workflow_dispatch`-only to an added `schedule: cron("0 2 * * *")` — "nightly backups" previously depended on someone remembering to trigger the workflow.

**Vibe Security 50 reference page:** `llms.txt` and the homepage cited "43 code/URL review and 7 requiring human evidence" with no page defining the 50 controls anywhere on the site. `apps/marketing/src/pages/vibe-security-50.astro` is generated directly from `packages/security/src/vibe-security-controls.ts` (deep-imported, not via the package index, which would pull `undici` into the Cloudflare Worker bundle) and throws at build time if the registry stops being exactly 50/43/7 — the published list and the cited counts cannot drift apart. Carries `WebPage` + `ItemList(50)` + `FAQPage` + `BreadcrumbList` JSON-LD and keeps the "no finding returned" (never "passed") framing from `docs/vibe-security-50.md`.

**SEO/AEO hygiene (`apps/marketing`):** the sitemap (`astro.config.mjs`) now emits `<lastmod>` from each blog post's `updatedDate ?? pubDate`, but only where a real date exists (100 of 149 URLs) — static pages deliberately carry no `lastmod` rather than a build-time stamp that would claim the whole site changed on every deploy. `robots.txt.ts` names `GPTBot`, `ClaudeBot`, `PerplexityBot`, `CCBot`, and `Google-Extended` explicitly rather than relying on the permissive wildcard alone. `SeoHead.astro` gained `twitter:site`. `Header.astro` gained a "Get started" primary CTA (linking to `/sign-up`) alongside the existing "Sign in" link, in both the desktop nav and the mobile menu, both carrying `data-cta-id`. Two findings from the same audit pass did **not** hold up on inspection and were left alone: `/scan` and `/sample-report` were already in the sitemap, and the blog `#collection` JSON-LD node (`isPartOf` in `BlogPost.astro` and `editorial-policy.astro`) already resolves against the id declared on the blog index — both verified by parsing the actual built HTML output, not by reading the source.

**Verification method for this entire batch:** a full local clone with dependencies installed, embedded Postgres with all 28 migrations applied, and the exact CI-shaped `NOBYPASSRLS` restricted role. Every commit in the batch was gated on: `pnpm lint` / `pnpm typecheck` (turbo, all packages) exit 0, `pnpm exec vitest run` against the real database (118 files / 1055 tests / 0 failures / 0 skips), `pnpm build` 6/6, `pnpm format:check` clean, and — for the workflow changes — YAML parse validation plus tracing the actual CI job logs after a real failure to find the root cause rather than guessing.

## §60 — CLI hardening, agent-config scanner bypass removal, and rate-limit expansion (2026-07-31, working changes)

A focused multi-package patch tightens the CLI contract, removes a scanner bypass, hardens secret installation, and adds per-workspace approval rate limits before a broader UX V2 follow-up. Code and tests are the source of truth; this section is the implementation map.

### CLI path and exit-code contract

- `packages/cli/src/client.ts` builds a `LyraShieldClient` from `@lyrashield/sdk` with `apiKey`, `apiUrl`, and a `lyrashield-cli/0.1.0` user agent. The SDK's `buildUrl()` prepends `/api/v1` automatically, so all CLI command handlers were moved to bare paths (`/findings`, `/scans`, etc.). This removes the earlier double-prefix bug and unifies how CLI and MCP call the API.
- `packages/cli/src/index.ts` now catches unhandled errors and maps `LyraShieldError.status` to exit codes: `3` for 401/403, `4` for other API/network failures, and `5` for 429. `packages/cli/src/output.ts` was refactored: `error(message, exitCode?)` exits with the supplied code in `--json` mode (default `2` in plain mode), and `fail(error, exitCode?)` is used for top-level exceptions.
- `packages/cli/README.md` now documents the full command catalog, environment variables, exit-code contract, and the `fix-plan` split.

### `fix-plan` CLI split

- `packages/cli/src/commands/fix-plan.ts` now does one of two things:
  - `lyrashield fix-plan <findingId>` is **read-only**: it `GET /findings/<id>` and returns `recommendedFix` and `plainLanguage`.
  - `lyrashield fix-plan create <findingId> --summary <summary>` is the **write** path: it `POST /findings/<id>/fix-proposals` with `workspaceId` and `summary`. The CLI validates `summary.trim().length >= 10`, matching the server-side Zod schema.
- This is a breaking change from the previous `fix-plan <findingId>` that always created a proposal; the CLI and docs were updated together to make the new shape discoverable.

### Agent-config scanner hardening

- `apps/worker/src/engine/scanners/agent-config-scanner.ts` removed the `lyrashield:begin/end` managed-block parser (`MANAGED_BLOCK_PATTERN`, `hashManagedBody()`, `stripManagedBlocks()`) and the `node:crypto` import it required. The rationale is fail-closed: a checksum-valid block was previously stripped before pattern matching, which would have allowed an attacker to hide malicious instructions inside a correctly-computed `<!-- lyrashield:begin ... -->...<!-- lyrashield:end -->` wrapper.
- All instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `skill.md`, `.github/copilot-instructions.md`, `.cursor/rules/lyrashield.mdc`, `.windsurf/rules/lyrashield.md`) are now scanned as plain text. The existing line/coverage bounds, code-fence skipping, and dangerous/protective pattern checks remain unchanged.
- `packages/agent-rules/src/__tests__/scan.test.ts` now contains two managed-block cases:
  - "does not treat a managed block with a wrong checksum as protective" (pre-existing), and
  - "still flags a managed block even when the checksum is correctly computed" (new).
    Both expect an `agent-instruction-poisoning` finding, confirming the bypass no longer exists.

### Agent registry path corrections

- `packages/agent-registry/src/agents.ts` fixes the global VS Code settings path from a vague `user settings.json` to `~/.config/Code/User/settings.json` with platform overrides for `darwin` (`~/Library/Application Support/Code/User/settings.json`), `linux` (`~/.config/Code/User/settings.json`), and `win32` (`~/AppData/Roaming/Code/User/settings.json`).
- Zed's global path is now `~/.config/zed/settings.json` instead of `user settings.json`.
- `packages/cli/src/installers/detect.ts` `resolveLocation()` already respects `ConfigLocation.platform`, so detection and install now resolve to the correct per-platform file.

### Agent registry schema additions

- `AgentEntry` gained `forceInlineEnv?: boolean`, `serverNamePattern?: string`, and `source?: { checkedOn: string; url: string | null }` in `packages/agent-registry/src/types.ts` and `src/schema.ts`.
- `forceInlineEnv: true` on `gemini-cli` replaces the previous hardcoded `agent.id === "gemini-cli"` branch in `packages/cli/src/installers/secret-mode.ts`.
- `serverNamePattern: "^lyrashield$"` on `gemini-cli` is enforced by `packages/agent-registry/src/render.ts`; `renderConfig()` and `renderEntry()` throw a clear error if the requested `serverName` does not match.
- Every agent now carries a `source` object so the registry records when and where each integration fact was last verified.

### Secret-mode installer refactor

- `packages/cli/src/installers/secret-mode.ts` was simplified. It no longer returns early for each credential kind; instead it derives a single `mode` (`inline`, `interpolated`, `shell`, `header`, or `manual`) and then checks whether that mode writes a raw secret (`inline` or `header`).
- If the target location is `sharedByConvention` and the mode writes a raw secret, the installer requires `--inline-secret` and confirms the file is either gitignored or not tracked. This prevents committing an `Authorization: Bearer <key>` header or an inline API key into a shared project config by mistake.
- `secretValue()` was removed; no other file referenced it. `packages/cli/src/installers/install.ts` passes the resolved `secret.mode` through to `renderEntry()`, which resolves the secret value in `packages/agent-registry/src/render.ts`.
- The refactor introduces two `as` casts for credential kind fields; a follow-up should replace them with a discriminated type guard.

### Rate limiting and approval controls

- `apps/web/src/lib/rate-limit.ts` adds `APPROVAL_CREATE_MAX = 10` and `checkApprovalCreateRateLimit(workspaceId)`, keyed on workspace so rotating IPs cannot bypass it. In production with `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`, it uses Upstash; otherwise it falls back to per-instance in-memory limiting.
- `apps/web/src/app/api/agent-approvals/route.ts` calls `checkApprovalCreateRateLimit()` after `requirePermission()` on the `POST` handler, returning 429 with `Retry-After` when the limit is exceeded.
- A new untracked `apps/web/src/middleware.ts` applies `checkApiRateLimit()` (30 requests per IP per minute) to all `/api/:path*`. It reads `x-forwarded-for` or `x-real-ip` and sets `X-RateLimit-Remaining`. This is a global backstop; it should be reviewed behind a trusted proxy before production hardening is complete.
- `packages/db/src/agent-approval-service.ts` default `expiresAt` was tightened from 24 hours to 15 minutes, matching the route default and the intended short-lived approval window.

### MCP and SDK path normalization

- `packages/sdk/src/client.ts` `buildUrl()` always prepends `/api/v1` to the supplied bare path, so both `packages/cli` and `packages/mcp` call it with bare paths. As a fail-fast guard, any path that already starts with `/api/` (e.g. `/api/v1/findings` or `/api/findings`) now throws `LyraShieldError { code: "INVALID_PATH" }` before the network request is made, converting a silent doubled-prefix 404 into a loud error.
- `packages/mcp/src/tools.ts` `apiCall()` now normalizes paths with `path.replace(/^\/api\/v1/, "").replace(/^\/api/, "") || "/"`, fixing the previous `path.slice(4)` bug that turned `/api/v1/findings` into `/v1/findings` and produced `/api/v1/v1/findings`.
- `packages/agent-registry/src/render.ts` now derives the remote-HTTP MCP endpoint with `deriveMcpUrl()`. The stdio `LYRASHIELD_API_URL` env block uses the base `apiUrl` directly; the remote-HTTP `url`/`serverUrl` resolves to `<base>/api/mcp`, and any stale `/api/v1` suffix is stripped first. `apps/marketing/src/components/AgentSnippet.astro` and the CLI installer both pass the base API URL, so manual copy-paste and programmatic installs now agree with `packages/mcp/README.md`.

### Manual install verification

- The §12.3 pre-publish gate was run against real config files for three representative agents: Windsurf (JSON, global), VS Code project (exotic `servers` root), and OpenAI Codex (TOML, non-JSON).
- In each case the CLI wrote a valid LyraShield entry, the file was parsed by the agent's expected parser, and the entry was removed cleanly without altering unrelated content.
- The actual installed command (`npx -y @lyrashield/mcp stdio`) was started and sent an `initialize` request; the server reported all 14 LyraShield tools, confirming the config files would load in the agents.

### Turbo task graph

- `turbo.json` adds a top-level `test` task with `dependsOn: ["^build", "generate"]` and `cache: false`. It also adds `"generate"` to `typecheck.dependsOn`. This ensures Prisma client generation runs before tests and typecheck, preventing stale generated types in CI.

### Local diff pattern severity

- `packages/cli/src/diff-core.ts` lowered the `eval-exec` local pattern from `HIGH` to `MEDIUM`. This is a deliberate advisory change: the `gate` default remains `--fail-on HIGH`, so `eval()` / `exec()` additions in a diff will not fail the gate unless the threshold is lowered. A security review should confirm this is the intended product behavior before merge.

### Verification and follow-up

- The patch should be verified with `pnpm lint`, `pnpm typecheck`, `pnpm --filter @lyrashield/cli test`, `pnpm --filter @lyrashield/agent-rules test`, `pnpm --filter @lyrashield/web typecheck`, `pnpm --filter @lyrashield/mcp typecheck`, and `git diff --check`. The new `middleware.ts` and the `eval-exec` severity change in particular need a security/operations review.

## §61 — Deep Review v11 remediation (unmerged branch `codex/deep-review-v11`, 2026-08-01)

A five-batch deep review remediation addressing stop-bleeding P0s, structural tenancy/RLS, worker recovery, build/deploy integrity, and polish/test regression fixes. Code, schema, and the new migration are the source of truth; this section maps the changes.

### Batch A — stop-bleeding P0s

- CLI install/agent P0s resolved. `packages/cli`, `packages/cli-alias`, and `packages/sdk` were adjusted to fix path/exit-code contract and installer behavior.

### Batch B — structural tenancy and child-table RLS

- `workspaceId` checks added to `packages/db/src/fix-proposal-service.ts`, `retest-service.ts`, `report-service.ts`, `agent-approval-service.ts`, and `schedule-service.ts`.
- `packages/db/src/score-service.ts` and `apps/worker/src/jobs/run-scan.job.ts` updated to pass `workspaceId` and use `withWorkspaceRLS` where required.
- Prisma migration `packages/db/prisma/migrations/20260803000001_child_table_rls/migration.sql` defined fail-closed RLS policies for `ScanEvent`, `Evidence`, `ScorecardShare`, `ScorecardEvent`, `ReferralCode`, `ReferralAttribution`, `NotificationPreference`, and `OnboardingState`. `20260803000002_child_table_rls_enable` enabled them. `20260803000003_child_table_rls_disable` then disabled RLS on these tables after a production `42501` outage, and **`20260807000003_child_table_rls_re_enable` restored it on 2026-08-07** once the cause was traced to `account-deletion.ts` updating `ScorecardShare` outside `withWorkspaceRLS`. The fail-closed tests are un-skipped, now assert a same-workspace write as well as cross-workspace reads, and run in the dedicated `rls-child-write-repro` CI job against real Postgres under a restricted role; see Deep Review v12 P0-1.
- Corresponding tests updated in `packages/db/src/fix-proposal-service.test.ts`, `retest-service.test.ts`, `schedule-service.test.ts`, `rls.test.ts`, and `score-service.test.ts`.

### Batch C — worker recovery

- `apps/worker/src/engine/command-builder.ts`, `finding-persister.ts`, `result-integrity.ts`, `scanner-orchestrator.ts`, and `apps/worker/src/index.ts` hardened worker recovery, result integrity, and engine command building.
- `apps/worker/src/jobs/run-scan.job.ts` and `run-scan.job.test.ts` updated.

### Batch D — build/deploy integrity

- OpenAPI spec builder moved from `apps/web/src/lib/openapi/` to `packages/types/src/openapi/` as a declared `@lyrashield/types/openapi` export. `apps/marketing/package.json` now depends on `@lyrashield/types`, and `apps/marketing/scripts/generate-openapi.ts` and `apps/web/src/app/api/v1/openapi.json/route.ts` consume the package export.
- `packages/types/package.json` adds the `./openapi` export; `packages/types/src/openapi/index.ts` re-exports `buildOpenApiSpec` and `OpenApiComponents`.
- `.github/workflows/deploy-azure.yml` pins all Docker and registry-cleanup actions to release SHAs (`docker/setup-buildx-action`, `docker/login-action`, `docker/build-push-action`, `dataaxiom/ghcr-cleanup-action`).
- Build job emits `web_digest` and `worker_digest`; app and scanner Container Apps deploy as `image:tag@sha256:<digest>` for immutable provenance.
- Worker image cleanup split to a separate `dataaxiom/ghcr-cleanup-action` invocation with `keep-n-tagged: 100` so a VM-pinned worker digest is not garbage-collected while still in use; web/scanner cleanup keeps `keep-n-tagged: 10`.

### Batch E — polish and test regression fixes

- `packages/cli/src/installers/atomic-write.ts` now checks only the immediate destination directory with `lstat` and `isSymbolicLink()`, fixing a false positive on macOS where `/var` is a symlink to `/private/var` and every temp path under it was rejected.
- `packages/cli/src/__tests__/installers/atomic-write.test.ts` adds a test proving a symlinked destination directory is rejected while non-symlinked paths under a symlinked ancestor remain writable.
- `packages/db/src/agent-approval-service.test.ts` adds a test proving `saveApprovalResult` scopes the update by both `id` and `workspaceId`.
- `apps/worker/src/engine/finding-persister.test.ts` updated to match new call signatures.
- `packages/agent-registry` snapshots regenerated to match the current 24-agent registry.

### Verification

- `pnpm lint` and `pnpm typecheck` pass for all 20 packages.
- `git diff --check` clean.
- Package unit tests pass for `@lyrashield/cli`, `@lyrashield/agent`, `@lyrashield/worker`, `@lyrashield/agent-registry`, `@lyrashield/types`, `@lyrashield/marketing`, `packages/db/src/agent-approval-service.test.ts`, `packages/db/src/score-service.test.ts`, `packages/db/src/scan-service.test.ts`, `packages/db/src/fix-proposal-service.test.ts`, `packages/db/src/retest-service.test.ts`, and `packages/db/src/rls.test.ts`.
- Full `pnpm test` reports **1337 passed**, **10 skipped**, **3 failed**; failures are limited to DB integration suites (`account-deletion`, `audit-concurrency`, `soft-delete`) that require a live Postgres/Redis stack, which is not available in this environment.
- `python3 .devin/scripts/checklist.py .` required checks (Security, Lint, Schema) pass.

## §62 — Dashboard UX final pass (unmerged branch `dashboard-ux-final-pass`, 2026-08-03)

The dashboard pages received a final UX pass focused on consistent headers and no-workspace empty states.

- `apps/web/src/components/page-header.tsx` introduces a shared `PageHeader` component that renders a title, optional `Lucide` icon, description, and action slot. It is used in place of page-specific header markup across `approvals`, `fixes`, `launch-readiness`, `notifications`, `projects`, `scans`, `scans/[id]`, `settings`, `targets`, and `team`.
- `apps/web/src/components/no-workspace-state.tsx` provides a consistent empty-state placeholder when a user has not yet created a workspace. The `scans`, `settings`, `targets`, `projects`, `team`, `approvals`, `fixes`, `launch-readiness`, `notifications`, and `scans/[id]` pages now surface it instead of hand-rolled copy.
- `page-header.tsx` was run through Prettier after the component was added.

## §63 — Engine fallback broadening, scan labeling, and CI quality gates (2026-08-04, engine `fix/broaden-delegate-fallback` + app `main`)

### Engine changes (`strix/core/runner.py`, `strix/core/execution.py`, `strix/interface/main.py`)

- **Broadened delegate fallback:** the root Terra agent now falls back to the Luna delegate on ANY `ModelBehaviorError`, not just `content_filter` errors. Previously, non-content-filter `ModelBehaviorError` from Terra would propagate as an unhandled exception and fail the scan with no salvage. If no separate delegate model is configured, partial findings are salvaged with `engine_stopped` terminal reason.
- **Transient `response.failed` handling:** Azure's `response.failed` status (without content-filter context) is now treated as a transient error in `_is_transient_model_error()` and retried with backoff. Previously it was treated as a permanent failure, causing scans to fail on transient Azure-side issues.
- **`engine_stopped` terminal reason:** new terminal reason for scans that stop due to non-content-filter model errors. Distinguished from `content_filter_stopped` for proper error categorization. Exit code mapping in `_non_interactive_exit_code`: 2 (findings present) or 5 (no findings).
- **Salvage on any delegate error:** when the delegate model also fails with any `ModelBehaviorError`, partial findings are salvaged with `engine_stopped` or `content_filter_stopped` terminal reason depending on the error type. Previously only `content_filter` errors triggered salvage.
- **Tests:** `tests/test_content_filter_recovery.py` updated with 23 tests covering the broadened fallback, transient `response.failed`, and salvage paths. All 939 engine tests pass.

### Worker labeling (`apps/worker/src/jobs/run-scan.job.ts`)

- **`engine_stopped` classification:** scans with `terminal_reason: "engine_stopped"` and findings are now classified as `COMPLETED` with `ENGINE_STOPPED` error category, rather than `FAILED` with `ENGINE_INCOMPLETE`. Without findings, they remain `FAILED`. This preserves partial results for the user when the engine stops after a model error but has already produced findings.
- The labeling logic mirrors the existing `content_filter_stopped` and `budget_exceeded` handling.

### Engine CI quality gates (`.github/workflows/ci.yml`, `.github/dependabot.yml`)

- **Full CI quality gates:** the engine CI workflow now runs ruff lint/format check, mypy type check, bandit security scan, and the full pytest suite. Previously CI only ran thin-fork verification, CLI build, and worker contract checks — pre-commit hooks only caught issues locally, and `--no-verify` could bypass all quality gates.
- **Dependabot Python:** Dependabot now tracks Python pip dependencies (was GitHub Actions only) with weekly schedule and 5 open PRs limit.
- **Example credentials redacted:** `admin:password123` in `--instruction` help text replaced with `testuser:REDACTED`.

### Dockerfile and compose hardening (`Dockerfile`, `docker-compose.yml`)

- **HEALTHCHECK instructions:** the runner (web) and worker Dockerfile stages now include `HEALTHCHECK` instructions. The web stage checks `http://127.0.0.1:3000/api/health`; the worker stage checks the `/tmp/lyrashield-worker-ready` heartbeat marker (2-minute freshness). Azure Container Apps uses external probes, but image-level health checks are good practice for any orchestrator that supports them.
- **Web resource limits:** the web service in `docker-compose.yml` now has CPU (`${WEB_CPU_LIMIT:-1.0}`) and memory (`${WEB_MEMORY_LIMIT:-512M}`) resource limits. The worker service already had limits; postgres and redis also had limits.

### E2E verification

A DEEP scan against an approved repository completed successfully after all fixes:

- 167 LLM requests, 14 engine findings (53 total findings), 9.8 minutes duration
- Exit code 2 (success with findings)
- Correct `COMPLETED` status with `ENGINE_STOPPED` error category
- Terra/medium → Luna/high routing worked as designed; the broadened fallback handled a non-content-filter `ModelBehaviorError` from Terra by switching to Luna/high, which completed successfully

## §64 — Blog batches 7–10, the compare collection, offline CI gates, and the homepage rewrite (2026-08-07 to 2026-08-08, 13 PRs merged, `main` at `476fcc0`)

- **Blog program grew from 100 to 161 articles across four new batches (batch-7 through batch-10), merged as five independent tranches** so each merge to `main` was a complete, self-consistent release: PR #227 (batch-7, 11 new integration checklists), PR #230 + PR #235 (batch-8, 22 posts — checklist-plus-workflow pairs for 11 more tools, split into two tranches because each tool's shared hero image needs both halves present in the same commit for the declared-`usageCount`-equals-actual check to pass), PR #233 (batch-9, the 15 workflow companions for the tools already covered by C1.16's `authority`–`batch-6` checklists), and PR #234 (batch-10, 13 comparison-vs-competitor blog posts). PR #232 and PR #239 were content-only updates to already-published posts (positioning refresh, then a final wording pass) and needed no program changes. `PROGRAM_ARTICLE_COUNT` is now `161`; the constant lives in `apps/marketing/scripts/blog-validation-lib.mjs`, not hardcoded per-script.
- **The image catalog grew from 36 to 75 entries.** `IMAGE_CORPUS = { authority: 1, shared: 74 }` replaces the exact `29×3 + 6×2` reuse histogram from C1.16 (§49), which cannot hold at this size — new images legitimately sit at usage 1 until a later tranche's second post repoints them. The invariant enforced on every commit instead: a manifest entry's declared `usageCount` must equal that image's actual assignment count, and every image's usage stays inside `1..MAX_SHARED_IMAGE_USAGE` (3). The exact-histogram assertion still exists but only runs under `--final-distribution`, an activation-time check, not a per-commit one.
- **A parallel content collection, `/compare`, was built from scratch (PR #229) and populated (PR #234).** Five previously hand-written, ungoverned `.astro` pages became 13 collection-backed pages under `src/content/compare/*.md`, with `src/content/compare-program.json` as the membership manifest and `compare:validate` as the release gate — same shape as the blog program, sharing `PROHIBITED_CLAIMS`/`PLACEHOLDERS` from `blog-validation-lib.mjs`. Each compare page generates `TechArticle`/`BreadcrumbList`/`FAQPage` JSON-LD from frontmatter and links bidirectionally to its comparison blog post.
- **Two new CI gates closed real gaps found while shipping this program.** `blog:validate:mdx` (PR #228) statically detects an inline-code span left unterminated in prose, which lets `${VAR}` or a stray `{...}` leak into a live MDX expression — this compiles without error and only fails Astro's build step at prerender, with no file name attached to the error. `blog:validate:offline` (PR #236) is a deterministic, no-network gate pairing a maintained `DEAD_URLS` denylist (`apps/marketing/scripts/blog-offline-gates.mjs`) with an unquoted-YAML-scalar check — `parseArticle`'s hand-rolled frontmatter reader accepts a bare `description: "...: ..."` that Astro's real `js-yaml` parser rejects as `bad indentation of a mapping entry`. Both are wired into `.github/workflows/ci.yml` alongside `blog:validate`, `blog:validate:images`, and `compare:validate`. `blog:check-links`, which resolves roughly 50 live third-party URLs, is deliberately kept out of the CI gate set (a transient `code.visualstudio.com` timeout during this program is the concrete reason) and is run manually.
- **Publishing model is confirmed tranche-merge, not draft scheduling.** `draft: true` on a program-mapped article fails `blog-validation-lib.mjs`'s `draft === false` release check, breaks `blog-program-complete.test.ts`'s published-count assertion, and — because the internal-link validator's `availableSlugs` set only contains non-draft posts — turns any published post's link into that draft into an `unpublished internal dependency` failure. `pubDate` has zero publish-gating logic anywhere in the codebase; it is a `.sort()` key and RSS field only, so setting a future date publishes the post immediately and sorts it to the top of the blog index. Confirmed by reading every `pubDate`/`draft` usage site, not inferred.
- **Homepage rewrite (PR #238):** `PremiumHero.astro`'s H1 changed to `"Ship AI-built apps with evidence, not hope."`, with an eyebrow, who-it's-for line, MCP-differentiator line, and dual CTAs (Lite Check anchored to the on-page `#free-scan` form via `seo.test.ts`'s updated canonical-navigation contract; account creation via `app.lyrashieldai.com/sign-up`). `lib/motion-manifest.ts`'s seven chapters (§49) were reworded in the same register; chapter `id`s, which key the immutable R2 motion media paths, are unchanged. A `@media (max-width: 480px)` block reorders the CTAs above the who-it's-for/differentiator copy via CSS `order` (DOM order, and therefore reading order and SEO, is untouched) and shrinks the H1 — verified in a headless-Chromium render of the actual `astro build` output, not asserted: the primary CTA's bounding box sits fully inside an 844px-tall 390px viewport. Desktop is byte-identical outside the new media query.
- **A transitive `nanoid` advisory (GHSA-2v37-7h3g-55p8, high) was cleared (PR #240)** via a `pnpm-workspace.yaml` `overrides` entry (`nanoid: ">=3.3.17"`), not `package.json`'s `pnpm.overrides` field, which pnpm 11 silently ignores. `nanoid` is not a direct dependency anywhere in the workspace; it arrives via `postcss` → `vite` → `@astrojs/cloudflare`.
- **Not yet done:** no scheduled workflow runs `blog:check-links`; a newly-dead external URL is only caught by a manual sweep or by already being in `DEAD_URLS`.

## §65 — OAuth/legal routes, MCP endpoints, and marketplace v0.1.8 (2026-08-09, PR #247, `main` at `dae5153`)

- **Hosted OAuth 2.0 for remote MCP clients is merged.** Remote MCP clients (`/api/mcp`) now authenticate via hosted OAuth with workspace selection and optional write scope, in addition to the existing `lsk_` API-key bearer flow. New routes in `apps/web/src/app/`: `/oauth/consent` (with `oauth-consent-form.tsx`), `/oauth/select-workspace` (with `oauth-workspace-picker.tsx`), `/device` and `/device/approve` (CLI device flow), `.well-known/oauth-authorization-server/api/auth`, `.well-known/oauth-protected-resource` (root), and `api/mcp/.well-known/oauth-protected-resource`. `apps/web/src/lib/oauth-resource-metadata.ts` provides the metadata helper. Remote connections are read-only by default; write actions require explicit scope and approval. OAuth clients can never use the `LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS` bypass.
- **OAuth provider schema is merged.** Migration `20260808000000_oauth_provider` adds `OAuthClient`, `OAuthConsent`, and `OAuthToken` models to `schema.prisma`, bringing the model count to 43 and the migration count to 31. `packages/auth/src/oauth.ts` implements the OAuth provider logic; `packages/auth/src/auth.ts` wires it into the Better Auth instance with advertised scopes and claims.
- **CLI OAuth device login is merged.** `packages/cli/src/commands/login.ts` implements a `login` command that opens a browser-based device approval flow, writes tokens to `~/.lyrashield/credentials.json` (0o600 perms), and falls back to `LYRASHIELD_API_KEY` from the environment. `packages/credentials/src/index.ts` is the single source of truth for that file — its location, env-over-file precedence, default API URL, and normalization — shared by the CLI and MCP server so the two cannot drift; both bundle it via `noExternal` so it stays private.
- **`@lyrashield/agent-plugin` package is merged.** Implements the open Agent Plugins v1.0.0 spec, packaging the MCP server and skills into a portable plugin with `plugin.json`, `mcp.json`, and `skills/lyrashield/SKILL.md`, plus client-specific manifest shims for Claude, Cursor, Codex, and Kiro. `packages/agent-plugin/src/export.ts` generates the deterministic marketplace release boundary; `packages/agent-plugin/schemas/plugin.schema.json` and `mcp.schema.json` validate the manifests. The plugin license is Apache-2.0; the hosted service remains proprietary. This brings the shared package count to 16.
- **Marketplace v0.1.8 is tagged and released** at `ecryptoguru/lyrashield-marketplace` (tag `v0.1.8`, release https://github.com/ecryptoguru/lyrashield-marketplace/releases/tag/v0.1.8). The export reconciles the drifted v0.1.7 with current source, including the corrected Codebuff publisher slug (`lyrashield`), refreshed OAuth/legal link metadata, and the Apache-2.0 plugin license. `docs/marketplace/CHANGELOG.md` records the v0.1.8 release notes; `docs/marketplace/README.md` documents the export boundary, submission order, and submission tracking.
- **Legal/support pages are merged.** `/privacy`, `/support`, and `/security-reporting` are live on the marketing site (`apps/marketing/src/pages/*.astro`).
- **Brevo email integration is verified locally.** `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=1` with `BREVO_API_KEY`, `EMAIL_FROM`, and `NOTIFICATION_FROM_EMAIL` set boots cleanly in `NODE_ENV=production`; a live test email was sent and accepted by Brevo (messageId `<202608082018.99543067577@smtp-relay.mailin.fr>`). Brevo IP security is disabled at the account level because Azure Container Apps Consumption has 180+ dynamic outbound NAT IPs that cannot be statically allowlisted. Production Container App secrets for `BREVO_API_KEY`, `EMAIL_FROM`, and `NOTIFICATION_FROM_EMAIL` are not yet provisioned — the production app still runs with `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0`.
- **MCP server updates:** `packages/mcp/src/tools.ts` added safety metadata and structured results to tool calls. `packages/mcp/src/server.ts` and `packages/mcp/src/create-server.ts` updated for OAuth bearer token support. `packages/mcp/README.md` documents the remote (Streamable HTTP) endpoint, OAuth authentication, and the operator-only `LYRASHIELD_MCP_ALLOW_REMOTE_MUTATIONS` opt-out.
- **Full release gate:** core, marketing, motion, and E2E suites plus lint, typecheck, format check, migration checks, and the `apps/web` production build must be green. Current command output is authoritative.

## §66 — Marketplace/CI/OAuth hardening and agent-plugin packaging (2026-08-10, PRs #249–#264, `main` at `d3b9868`)

- **v0.1.8 reconciliation and agent-plugin packaging (PR #249, `43a9ac6`, plus `b00b099`, `cc94d1b`, `ff5e2c9`, #250 `8027f08`, and #251 `49c09ee`).** `packages/agent-plugin` is bumped to 0.1.10 and the marketplace export now includes a root `.mcp.json`, the `skills/` directory, client-specific `plugin.json` shims for Claude, Codex, Cursor, and Kiro, and the `lyrashield-marketplace` repository URL. `build.ts` writes per-client manifests and `export.ts` includes `apps/agent` in the forbidden list. `chatgpt-app-submission.json` is added. OAuth workspace selection is preserved via the new `packages/auth/src/oauth-workspace.ts` helper and the `activeWorkspaceId` cookie before consent. #250 refreshes `AGENTS.md`, `codebase.md`, `PRD.md`, `LOCAL_SETUP.md`, `PRODUCTION_DEPLOYMENT.md`, `.env.example`, `packages/mcp/README.md`, and `docs/marketplace/README.md` for v0.1.8. #251 refreshes the selected workspace during OAuth consent.

- **Remove unused `apps/agent` package (PR #252, `b275ad7`).** The `apps/agent` application, package manifest, source, and tests are removed; `.github/scripts/classify-paths.sh`, `.github/workflows/ci.yml`, `README.md`, `Dockerfile`, `turbo.json`, and `packages/agent-plugin/src/export.ts` are updated to stop referencing it. This reduces the app count from 5 to 4 and the shared package list is now 18.

- **Deprecate `@lyrashield/cli` alias (PR #253, `3a06ff1`).** `packages/cli-alias/src/index.ts` now prints a `DeprecationWarning` and dynamically imports the primary `lyrashield` package; `README.md`, `packages/cli-alias/README.md`, and `packages/cli-alias/package.json` point users to the unscoped `lyrashield` package. The alias remains for backward compatibility and will be removed in the next major release.

- **Remove unused dev dependencies and document repository boundaries (PR #254, `00ffcb5`).** Drops unused dev dependencies from `package.json`, `apps/marketing/package.json`, and `pnpm-lock.yaml`; updates `.prettierrc.json`; adds the `Repository boundaries and generated artifacts` section to `AGENTS.md` noting the deprecated `@lyrashield/cli` alias and the local-only nature of build artifacts.

- **Preserve OAuth workspace selection through consent (PR #255, `be97935`).** Adds `apps/web/src/app/oauth/oauth-query.ts` with `serializeOAuthQuery`, used by `/oauth/consent` and `/oauth/select-workspace` to preserve the signed OAuth request query across sign-in and consent, and adds `apps/web/src/app/oauth/oauth-query.test.ts`.

- **Preserve repeated OAuth query parameters (PR #257, `2667d5a`).** Updates `serializeOAuthQuery` to use `URLSearchParams.append` for array values instead of overwriting them, with a regression test for repeated parameters.

- **Allow OAuth MCP clients to request write scope (PR #258, `7b079d6`).** `packages/auth/src/auth.ts` sets `clientRegistrationDefaultScopes` to the full `oauthScopes` list so dynamic MCP clients can request the approval-gated `lyrashield.write` scope; actual writes still require consent and per-action approval.

- **Raise eval/exec gate severity, guard timeout, and correct proxy docs (PR #259, `679319b`).** `action.yml` adds `bump_severity` to report the worst issue across the diff, raises the `eval/exec` pattern to `error`/`HIGH`, and fixes regex quoting. `packages/cli/src/diff-core.ts` also raises `eval/exec` to `HIGH`. `packages/mcp/src/prompt-injection-guard.ts` adds a 1-second `timeoutMs` budget and fails closed with `guard_timeout`. `apps/web/src/proxy.ts` and `apps/web/src/lib/csp.test.ts` add `checkLiteScanRateLimit` mocking; the working-changes note in `AGENTS.md` is corrected to reference `proxy.ts` instead of `middleware.ts`. Branch commit `ff11dc8` adds `.github/workflows/update-action-version.yml` to move the `v1` action tag and create a release on green merge to `main`.

- **CI and backup fixes (PR #260, `1313509`).** `.github/workflows/ci.yml` sets `BETTER_AUTH_SECRET` to a static dummy value in the test job so forks and Dependabot PRs can run tests; `.github/workflows/production-backup.yml` robustly strips `uselibpqcompat` (and URL-encoded variants) from `DATABASE_DIRECT_URL` before `pg_dump`.

- **Web location lint (PR #261, `060ff6e`).** `apps/web/src/app/(dashboard)/dashboard/settings/delete-account.tsx` and `apps/web/src/app/device/page.tsx` use `useRouter().push()` instead of `window.location.assign` so redirects are covered by Next.js lint and routing.

- **OpenAI domain verification challenge (PR #262, `0cd22da`).** Adds `apps/web/src/app/.well-known/openai-apps-challenge/route.ts` (and `route.test.ts`) that returns `OPENAI_APPS_DOMAIN_VERIFICATION_TOKEN` as plain text or 404 when not configured.

- **Align marketplace artifacts with official client schemas (PR #263, `21f1e11`).** Adds `$schema` and `Authorization: Bearer ${LYRASHIELD_API_KEY}` to `.mcp.json`; wires `.claude-plugin` and `.codex-plugin` to `.mcp.json` via `mcpServers`; adds client-specific manifests for Cursor (inline `mcpServers` and `variables` schema for `LYRASHIELD_API_KEY`) and Kiro (`.mcp.kiro.json` with npx stdio server); adds Cline `docs/marketplace/cline/mcp.json`, `llms-install.md`, and `README.md`; adds Codebuff `lyrashield-review.ts` and Kilo `MCP.yaml`; updates the Zed extension id to `lyrashield-mcp` and adds settings/installation docs; adds Gemini extension settings and OpenClaw skill frontmatter; includes `apps/agent` in the marketplace export forbidden list.

- **Declare Zed Node capability (PR #264, `d3b9868`).** `docs/marketplace/zed-extension/extension.toml` adds `[[capabilities]] kind = "process:exec"` with `command = "node"` and `args = ["**"]` so Zed can run the npm-installed MCP server.

## §67 — URL/API capability-aware reviews and Vibe 50 evidence-bounded outcomes (2026-08-10, PRs #272–#273, `main` at `5209646`)

- **URL scan capability registry (`url-scan/2.0.0`).** `packages/types/src/url-scan-capabilities.ts` is the single source of truth for six released profiles: `WEB_APP_SAFE` (Surface Review), `WEB_APP_STANDARD` (Expanded Surface Review), `WEB_APP_DEEP` (Behavioral Surface Review), `API_SAFE` (Endpoint Review), `API_STANDARD` (Contract Review), and `API_DEEP` (Contract Behavior Review). Each profile carries bounded numeric limits for `maxDocuments`, `maxAssets`, `maxDepth`, `maxTotalBytes`, `maxResponseBytes`, `maxConcurrency`, `maxWallTimeMs`, `maxOperations`, `maxMethodProbes`, `maxOriginProbes`, `allowedMethods`, and `requiresApiSpec`. A change to any limit or allowed method is a contract change and must bump the version and update fixtures. `RELEASED_URL_PROFILE_IDS` controls which profiles are selectable in the dashboard and API.
- **Shared SSRF-safe public-surface collector.** `packages/security/src/public-surface.ts` extracts the surface collector previously inlined in the Lite Scanner so the worker and the Lite Scanner share one SSRF-safe implementation. `packages/security/src/public-surface-analysis.ts` unifies header (CSP, HSTS, frame protection, nosniff, referrer policy, permissions policy), transport (insecure transport, mixed content), cookie, verbose-error, source-map, framework-marker, and high-confidence secret-pattern detection (excluding public anon keys). `packages/security/src/safe-fetch.ts` extends `SafeFetchOptions` with `method`, `origin`, and `accept` plus a hard GET/HEAD/OPTIONS allowlist.
- **Standard web discovery (`WEB_APP_STANDARD`).** `collectPublicSurface` performs deterministic same-origin BFS anchor discovery, reads `/robots.txt`, `/sitemap.xml`, and source-map references within profile-scoped limits for documents, assets, bytes, and wall time. Release-gate tests in `public-surface.test.ts` cover the bounded discovery.
- **Deep web behavior probes (`WEB_APP_DEEP`).** `apps/worker/src/engine/scanners/url-behavior-probes.ts` runs `runUrlBehaviorProbes`, issuing bounded HEAD, OPTIONS, and alternate-origin GET requests. It detects reflected-origin CORS with credentials (control 14) while deliberately ignoring wildcard + credentials. `UrlExecutionSummary` records `methodProbeCount` and `originProbeCount`.
- **API Contract and Contract Behavior reviews.** `apps/worker/src/engine/scanners/openapi-scanner.ts` parses OpenAPI 3.x specs (JSON/YAML), performs safe GET/HEAD/OPTIONS operations based on documented parameters, enforces operation budgets (10 for STANDARD, 25 for DEEP), skips operations requiring authentication or sensitive parameters, validates response content types against schema declarations, and maps to Vibe Security 50 control ID 13. `Target.apiSpecUrl` (Prisma migration `20260810014636_add_api_spec_url`) is validated as public HTTPS with no credentials, query, or fragment and is required for API STANDARD/DEEP. A second migration disables legacy URL STANDARD/DEEP schedules.
- **Target/mode parity enforcement.** `/api/scans` rejects SAFE/QUICK-only for `WEB_APP`/`API` targets and rejects STANDARD/DEEP/CUSTOM for non-API targets without an OpenAPI spec. `getManualScanOptions` in scan-presets keeps three repo options, exposes only Safe for WEB_APP/API, and accepts the hidden legacy QUICK alias. The schedule runner disables/ignores URL STANDARD/DEEP schedules unless the target is an API with an OpenAPI spec. The dashboard scan/schedule forms show target-aware options and hide unavailable modes; locked options explain why they are unavailable.
- **Vibe 50 evidence-bounded outcomes (PR #272).** `packages/security/src/vibe-security-controls.ts` and `apps/worker/src/engine/result-integrity.ts` make Vibe 50 outcomes evidence-bounded: an unmatched engine-led control remains `INCONCLUSIVE` rather than being presented as passed. `apps/worker/src/engine/scanners/secrets-scanner.ts` and `agent-config-scanner.ts` were hardened so a correctly-checksummed managed block can no longer hide malicious instructions and secrets detection remains evidence-bounded. `packages/db/src/score-service.ts` and `report-generator.ts` stop deriving a passing outcome from the absence of a finding. `docs/vibe-security-50.md` documents the honest result language and the URL/API scan scope. `apps/worker/src/engine/scanner-orchestrator.ts` passes the resolved `UrlScanProfile` through the scanner orchestrator instead of hardcoding `WEB_APP_SAFE`.
- **Reports expose URL scan scope and limitations.** `packages/db/src/report-generator.ts` (and `report-generator.test.ts`) adds URL scan scope and limitations sections to generated reports so a URL/API scan report does not imply repository or operational coverage.
- **Documentation.** `docs/specs/2026-08-10-url-api-scan-modes-design.md`, `docs/plans/2026-08-10-url-api-scan-modes-implementation.md`, and `docs/plans/2026-08-10-url-api-scan-modes-starter-prompt.md` record the design and implementation plan. `docs/vibe-security-50.md` and `userguide.md` were updated for the six URL/API modes and the non-mutating behavior of Behavioral Surface Review and Contract Behavior Review.

## §68 — Reproducible engine releases, release-copy alignment, and OAuth-first marketplace (2026-08-12, PRs #275–#280, `main` at `23d064e`)

- **First-run dashboard review experience (PR #275, `8a6fe93`).** The onboarding wizard (`apps/web/src/app/onboarding/onboarding-wizard.tsx`), dashboard home (`apps/web/src/app/(dashboard)/dashboard/page.tsx`), scans client (`scans-client.tsx` + `scans-client.utils.ts`), `get-started-checklist.tsx`, `trust-command-center.tsx` (+ `trust-command-center.utils.ts`), and `dashboard-section-tabs.tsx` are streamlined for first-run review. Milestone prerequisites are enforced, retry target and milestone actions are locked until prerequisites are met, and existing targets are restored and retried. `/api/workspaces/route.ts` returns the first-workspace state needed by the wizard. `e2e/critical-flow.spec.ts` adds a first-run critical-flow path. `apps/web/next.config.ts` adds the worktree-ignore entry.
- **Reproducible engine releases (PR #276, `2198346`).** `.github/scripts/verify-engine-revision.sh` asserts the pinned `ENGINE_REVISION` in `deploy-azure.yml` is a 40-char SHA, merges into engine `main`, and has successful `verify` and `Build and smoke-test sandbox image` check runs. `apps/worker/scripts/verify-worker-image.sh` validates non-root user, exact app/engine OCI labels (`org.opencontainers.image.revision`, `io.lyrashield.engine.revision`), CLI presence, absence of `.env` files and private-key material, absence of viewer frontend and product test source, and emits a deterministic Python dependency manifest SHA-256. `apps/worker/src/docker-runtime.test.ts` covers the worker image policy. PR CI (`.github/workflows/ci.yml`) checks out the pinned engine revision, runs `scripts/verify-worker-contract.sh`, builds the worker, and verifies the worker image; the main deployment repeats provenance/contract checks, builds and pushes the SHA-only worker candidate, pulls its exact digest, and verifies OCI labels before any deploy. `engine-NOTICE.md`, `Dockerfile`, `.dockerignore`, `apps/worker/README.md`, `ops/worker/README.md`, `docs/deployment/LOCAL_SETUP.md`, `docs/deployment/PRODUCTION_DEPLOYMENT.md`, `docs/marketplace/README.md`, `packages/cli/README.md`, `product.md`, and `userguide.md` document the new boundary.
- **Pin merged engine revision (PR #277, `5a5a26b`).** `deploy-azure.yml` advances `ENGINE_REVISION` to the exact merged engine commit after its checks passed; the pin blocks silent mutable-tag updates, not later verified promotions. The previous digest is retained for rollback.
- **OAuth-first marketplace integrations (PR #278, `48b13b6`).** The generated Cursor and Kiro shims are OAuth-first (no raw API-key variable in the plugin manifest); the Zed extension starts from the local OAuth credential store with the settings API key as an explicit CI/non-OAuth fallback using only `npm:install` capability (the `process:exec` capability from PR #264 was removed as unnecessary — `docs/marketplace/zed-extension/extension.toml`, `src/lib.rs`, `Cargo.toml`, `default_settings.jsonc`, and `installation_instructions.md` were updated). `packages/credentials/src/index.ts` hardened the shared credential store with token refresh, revocation, env-over-file precedence, and a single source of truth for `~/.lyrashield/credentials.json` location and normalization; `packages/cli/src/credentials.ts`, `packages/cli/src/commands/logout.ts`, `packages/mcp/src/credentials.ts`, `packages/mcp/src/server.ts`, and `packages/cli/src/installers/secret-mode.ts` were aligned to OAuth-first setup. `packages/agent-registry/src/index.ts` added an OAuth-first install path and `packages/cli/src/commands/init.ts` + `install.ts` prefer it. All `apps/marketing/src/pages/docs/integrations/*.astro` pages were updated to OAuth-first copy. `docs/marketplace/CHANGELOG.md` records the OAuth-first change. `packages/credentials/src/index.test.ts` and `packages/mcp/src/credentials.test.ts` cover the new behavior; `packages/cli/src/__tests__/installers/conformance.test.ts` and `packages/agent-registry/src/__tests__/registry.test.ts` cover the installer conformance.
- **Production web/worker environment boundary (PR #279, `d49d1c2`).** Sandbox image validation (`LYRASHIELD_IMAGE`) is scoped to the worker only: `packages/config/src/env.ts` no longer asserts it (the assertion moved to `apps/worker/src/engine/runner.ts`, which validates the exact sandbox image reference at scan time with `env-runtime.test.ts` and `runner.test.ts` coverage). Web and Lite Scanner Container Apps must not require or receive worker sandbox configuration; `ops/worker/run-worker.sh` owns injection of worker-only model, engine, Docker, sandbox, reaper, telemetry, and concurrency values. The worker-only `DATABASE_SYSTEM_URL` (privileged ownership-check role) is mapped by `ops/worker/refresh-secrets.sh` and must not be set on web or Lite Scanner processes. `.github/workflows/ci.yml` no longer asserts `LYRASHIELD_IMAGE` in the test job.
- **Evidence copy and rollback recovery alignment (PR #280, `23d064e`).** The bundled skill (`packages/agent-plugin/plugin/skills/lyrashield/SKILL.md`), MCP tool descriptions (`packages/mcp/src/tools.ts` + `tools.test.ts`), and `packages/agent-rules/src/policy.ts` (+ `renderers.test.ts`) now describe the fix→verify loop in evidence-bounded language: the post-fix step polls the returned retest scan to a terminal state and calls a result independently verified only when a separate independent-verification receipt exists; `lyrashield_check_diff` is framed as an advisory pre-filter, not a substitute for a full recorded scan; `lyrashield_create_pr_security_recap` now paginates all open findings by severity instead of a fixed 100-row cap. `deploy-azure.yml` rollback recovery now queries `latestRevisionName`, sorts all revisions by creation time, activates the previous one, explicitly assigns 100% traffic via `az containerapp ingress traffic set`, and retries readiness for up to 12 attempts; the scanner deploy/smoke steps use `if: always() && steps.deploy-*.outcome == 'success'` so a scanner-config gap does not mask an app rollback. `docs/deployment/PRODUCTION_DEPLOYMENT.md` documents the rollback boundary and the worker-only configuration section. `packages/agent-plugin/src/build.ts` (+ `build.test.ts`) and `packages/agent-rules/src/renderers/windsurf.ts` were aligned. 16 integration blog posts (`apps/marketing/src/content/blog/*-mcp-security-workflow.mdx`) were copy-aligned in the same pass. `apps/marketing/scripts/blog-validation-lib.mjs` and `apps/marketing/src/content/blog-program.json` were updated. `chatgpt-app-submission.json`, `docs/marketplace/zed-extension/README.md`, `extension.toml`, `installation_instructions.md`, and `docs/plans/2026-07-14-vibe-coder-security-seo-tools-plan.md` were refreshed. `plugin-ux-improvements.md` and `userguide.md` were updated for the evidence-bounded language.

## §69 — Claims readiness map and UI label cleanup (2026-08-13)

- **Claims readiness map (`docs/claims-readiness.md`).** A new internal document records what each of five prohibited claims ("SOC 2 compliant," "certified," "guarantees security," "AI safety tested," "adversarial robustness proven") legally or technically means, what LyraShield has today that supports or relates to it, what is missing, the codebase additions needed, the honest alternatives available now, and the realistic timeline and cost for each. It cites the relevant frameworks (AICPA TSC, ISO 27001/42001, NIST ARIA, NIST AI 100-2e2025, MLCommons AILuminate, ISO/IEC AWI TS 42119-7/8, OWASP Gen AI, HarmBench, UK AISI) and case law (Royal Indem. Co. v. Security Guards, Inc.; Jewels by Iroff v. Securitas; David Gutter Furs v. Jewelers Protection Services). It includes a recommended sequencing plan and ongoing guardrails (CI grep for prohibited claim patterns, manual copy review before indexable deploys, quarterly review of the document).
- **AGENTS.md claims discipline.** The non-negotiable implementation rules now explicitly prohibit the five claims and require contributors to consult `docs/claims-readiness.md` before adding marketing copy.
- **AI assurance governance plan updated.** `docs/superpowers/plans/2026-08-13-ai-assurance-governance.md` now references `docs/claims-readiness.md` in its explicit non-goals, adds a claims-readiness summary table, and adds a handoff checklist item requiring a grep for prohibited terms before adding marketing copy.
- **Production beta readiness plan updated.** `docs/plans/2026-07-20-production-beta-readiness.md` now lists the five prohibited claims in its out-of-scope section.
- **Vibe Security 50 doc updated.** `docs/vibe-security-50.md` adds a claims-discipline section stating the coverage contract is not a certification.
- **Lite scanner doc updated.** `docs/lite-scanner.md` adds a claims-discipline item referencing `docs/claims-readiness.md`.
- **User guide updated.** `userguide.md` adds a claims-discipline paragraph and renames the report-type reference from "compliance" to "assurance" (internal type value unchanged for backward compatibility).
- **Editorial policy updated.** `apps/marketing/src/pages/blog/editorial-policy.astro` adds a "Prohibited claims" section and a footer reference to `docs/claims-readiness.md`.
- **Methodology page updated.** `apps/marketing/src/pages/methodology.astro` adds a paragraph stating LyraShield does not make the five prohibited claims and referencing `docs/claims-readiness.md`.
- **Evidence vault page updated.** `apps/marketing/src/pages/evidence-vault.astro` adds a FAQ entry explicitly answering "Does this make LyraShield SOC 2 compliant, certified, or adversarially robust?" with "No."
- **llms.txt updated.** `apps/marketing/src/pages/llms.txt.ts` adds the prohibited-claims statement to the copy-safe summary for LLM context.
- **Report type UI label.** `apps/web/src/app/(dashboard)/dashboard/reports/reports-client.tsx` renames the "Compliance" report-type tab and badge to "Assurance" (internal type value `compliance` unchanged for backward compatibility; `REPORT_TYPE_LABEL` map renders the friendly name).

## §70 — AI App Security scanner (Release A) and AI safety eval harness (2026-08-13)

- **Deterministic AI-layer static-analysis scanner.** A new control set, "AI App Security 8," maps eight statically detectable signals to the OWASP Top 10 for LLM Applications (2025): AI-01 (prompt-injection input validation, LLM01), AI-02 (sensitive data in LLM context, LLM02), AI-03 (AI library supply chain, LLM03 partial), AI-04 (LLM output in dangerous sinks, LLM05), AI-05 (unbounded agent permissions, LLM06), AI-06 (system prompt exposed to client, LLM07), AI-07 (unauthenticated vector DB / RAG access, LLM08 partial), and AI-08 (missing LLM consumption limits, LLM10). The shared browser-safe core lives in `packages/security/src/ai-security/` (`types.ts`, `controls.ts`, `scan.ts`, per-rule modules under `rules/`, `score.ts`, `triage.ts`) and exposes `scanAiSecurityFiles(files, limits)`, `summarizeAiSecurityCoverage(signals)`, `computeAiSecurityScore(result)`, and `AI_SECURITY_DETECTOR_VERSION`. Result states are `DETECTED`, `NO_FINDING`, `INCONCLUSIVE`, and `NOT_ASSESSED`; unsupported or truncated input cannot become `NO_FINDING`. The control set is separate from the Vibe Security 50 to preserve its stable semantics.
- **Free browser-local product-led SEO tool.** `/tools/ai-app-security-scanner` (`apps/marketing/src/components/tools/AiAppSecurityScanner.astro` + `apps/marketing/src/lib/ai-app-security.ts`) runs AI-01, AI-02, and AI-04 through AI-08 entirely in the browser with no account, upload, advisory lookup, or LLM. It accepts pasted code or selected local files (≤25 files, 1 MiB/file, 5 MiB total) and renders evidence-state counts, control mappings, bounded evidence, remediation, supported scope, limitations, and a primary CTA to "Create account and scan the complete repository." AI-03, full-repository context, optional LLM triage, persistent evidence, retest, reporting, and the numeric score are gated to the paid repository scan. The free tool shows no numeric score because selected-file coverage is user-controlled and incomplete. The privacy promise is rendered with `data-testid="tool-privacy"`.
- **Paid full-repository deterministic scanning and AI-03.** `apps/worker/src/engine/scanners/ai-app-security.ts` adapts bounded source files and uses exact supported lockfile resolutions for AI-03. The PostgreSQL cache and OSV batch boundary return an explicit complete/partial/unavailable receipt; a clean AI-03 outcome requires complete resolution plus a fresh complete response. SCA execution remains a separate legacy path pending the planned shared inventory refactor.
- **Optional bounded LLM triage overlay.** `packages/security/src/ai-security/triage.ts` is currently reusable helper code only. It is not a production engine integration: the required controlled-engine command, redaction receipts, protected accounting, policy controls, contract artifact, engine pin, and release proof are still pending.
- **Private paid AI App Security Score.** `packages/security/src/ai-security/score.ts` calculates a private score only after at least six controls, complete fresh AI-03, and no global scanner limit. `AiSecurityScoreSnapshot` is workspace-scoped, forced through RLS, immutable, and never public. Disposition carry-forward, full receipt persistence, and final UX/browser proof are not yet complete.
- **Paid dashboard AI score card and API.** `apps/web/src/app/api/scans/[id]/ai-score/route.ts` exposes an authenticated, workspace-scoped endpoint. `apps/web/src/app/(dashboard)/dashboard/scans/[id]/ai-score-card.tsx` renders the score beside "assessed N of 8," evidence-quality counts, methodology version, advisory freshness, and limitations. The dashboard groups finding detail into deterministic detection, advisory context when applicable, optional triage, evidence state, and next action. `LIKELY_FALSE_POSITIVE` remains scored until an authorized user records false positive with a reason; accepted risk remains scored. Fix proposal, retest, and assurance-report actions use existing approval and evidence semantics.
- **Private reports and conversion attribution.** `packages/db/src/report-generator.ts` adds a private `AI App Security Score` section bound to the workspace-scoped score snapshot with non-certification disclaimers. AI score, coverage, and provenance are added to private reports without exposing model cost or private accounting. Signup attribution uses only the existing privacy-safe source/channel mechanism; no code, filenames, findings, or evidence are placed in URLs or analytics events.
- **AI safety evaluation harness.** `packages/eval-ai-safety/` evaluates LyraShield's deterministic `PromptInjectionGuard` (not an underlying LLM's general safety training) against the OWASP Gen AI Red Teaming Guide (42 test cases; 85.7% expected-outcome match) and the MLCommons AILuminate demo set (292 prompts; 4.5% guard-rule match, observational only). Results are published on `/ai-safety` (`apps/marketing/src/pages/ai-safety.astro`) with bounded, honest language. The harness documentation explicitly states it evaluates the guard, not a model's safety training.
- **Evidence storage.** `packages/evidence-storage/src/index.ts` and `packages/evidence-storage/src/local.ts` provide append-only, private, encrypted artifact storage with workspace isolation using `withWorkspaceRLS` and `FORCE RLS`. AI-assurance data is never exposed in public report/share payloads.
- **E2E and verification.** `e2e/marketing-ai-app-security-tool.spec.ts` covers the marketing scanner: page/privacy, browser-local pasted-code scan with no network request, keyboard navigation (Chromium), and mobile layout visibility. `e2e/ai-assurance.spec.ts` covers the dashboard AI assurance workflow: anonymous APIs reject access, auth forms recover from network failure, the AI assurance dashboard lists the seven evidence-required controls, and tenant boundaries deny another user. Verification on 2026-08-13: `pnpm typecheck` 30/30, `pnpm lint` 28/28, `pnpm test:core` 1,754 passed / 9 skipped, `pnpm test:e2e` 4/4, marketing E2E 7 passed / 1 skipped (mobile WebKit has no hardware Tab key), master checklist required checks passed (UX/SEO advisory). E2E fixes: stable `#ai-app-run` and `data-testid="tool-privacy"` selectors; `apps/marketing/src/middleware.ts` strips `upgrade-insecure-requests` over HTTP in dev so WebKit mobile tests can load local scripts. See `docs/plans/2026-08-13-ai-app-security-scanner.md` and `docs/claims-readiness.md`.

## §71 — Sprint 10 shared schema foundation (2026-08-18)

- **Three-track integration.** Sprint 10 merged three tracks to `main` on a shared schema foundation: Track A (Cloud billing), Track B (BYOK Local/Desktop licensing), Track C (Affiliate & partner program). Nine Prisma migrations under `packages/db/prisma/migrations/` (`20260818*` and `20260819*`) add `STARTER` to the `WorkspacePlan` enum, billing fields on `Workspace` (`graceUsedMs`, `graceCycleStart`, `deepAllowed`, `trialStartedAt`) and `BillingAccount` (`interval`, `currentPeriodStart/End`, `canceledAt`, `region`, `spendLimitCents`), the `MinutePack` model, the full license domain (5 models), and the full affiliate domain (10 models + 3 enums). All monetary fields use `Decimal @db.Decimal(19,4)`; all IDs are `cuid`. The `STARTER` enum migration uses `ALTER TYPE ... ADD VALUE` (non-transactional — deployed before code references it).
- **New packages.** `packages/billing`, `packages/licenses`, `packages/pricing`, `packages/affiliate` are new workspace packages. `packages/pricing` is the single source of truth for plan definitions, minute packs, and local SKUs; `packages/billing` re-exports it. `packages/billing` and `packages/affiliate` are bundled via `noExternal` where needed to keep provider logic private.
- **Security remediation.** 41 CRITICAL/HIGH issues were fixed across the three tracks in a dedicated remediation commit, followed by 57 MEDIUM/LOW issues fixed in 5 phase commits (Tier 1 financial integrity → Tier 8 audit/tests). See `.devin/plans/sprint-10-medium-low-remediation.md` and `.devin/plans/sprint-10-medium-low-findings.md` for the full findings.

## §72 — Cloud billing, usage metering, and entitlements (2026-08-18, Sprint 10 Track A)

- **Dual-gateway billing (`packages/billing`).** Polar is the global merchant-of-record (USD); Razorpay serves India (INR, UPI, GST). Geo-routing in `packages/billing/src/geo.ts` resolves the provider server-side from `cf-ipcountry` (only trusted when `TRUSTED_PROXY_IP_HEADER` is configured — prevents spoofing). The checkout route (`apps/web/src/app/billing/checkout/route.ts`) requires `billing:manage` permission, resolves the affiliate promo code, and creates a hosted checkout (Polar) or subscription (Razorpay). The portal route (`apps/web/src/app/billing/portal/route.ts`) returns the Polar customer portal URL. The webhook route (`apps/web/src/app/billing/webhook/route.ts`) is a single endpoint for both providers: it detects the provider by headers (`webhooks-id` for Polar, `X-Razorpay-Signature` for Razorpay), validates the signature, inserts a `WebhookEvent` (idempotent on `@@unique([provider, externalId])`), and processes synchronously — Track A (billing entitlements), Track B (license issuance for Local SKU Polar orders), Track C (affiliate commission/clawback dispatch) — before responding 200.
- **Plan definitions (`packages/pricing/src/plans.ts`).** Five cloud plans: TRIAL (100 min, 3 targets, no Deep, $0), STARTER ($29/mo or $295/yr, 300 min, 5 targets, no Deep), PRO ($99/mo or $950/yr, 1,200 min, 15 targets, Deep enabled), TEAM ($299/mo or $2,690/yr, 4,000 min, 50 targets, Deep + overage), AGENCY ($499/mo, custom, contact-led). Annual discounts: STARTER 15%, PRO 20%, TEAM 25%. INR pricing = USD × 100. Minute packs (`packages/pricing/src/packs.ts`): 100/$15, 250/$30, 500/$50, 180-day validity. Overage: $0.15/min (Team opt-in with spend limit). Deep scan multiplier: 3×. Local SKUs (`packages/pricing/src/local.ts`): individual_launch $199, individual_regular $299, team_perpetual $99/seat, team_subscription $149/seat/yr, renewal $59/seat/yr, sync_addon $49/seat/yr; 10% off at 10+ seats.
- **Trial lifecycle (`packages/billing/src/trial.ts`).** 14-day trial, 100 agent-minutes (one-time grant), 3-target cap, Standard/Quick only (no Deep). `startTrial()` sets `trialStartedAt` and grants 100 minutes idempotently. `getTrialState()` returns isActive/isExpired/daysLeft/minutesLeft. `blockOnExpiry()` sets billing status to `trial_expired`.
- **Usage metering.** `getUsageBalance()` (`packages/billing/src/usage/balance.ts`) computes the current-cycle balance: pool (monthly grant) + Σ unexpired pack minutes − consumed. Draw order: monthly pool first, then oldest pack (FIFO), then overage. `recordAgentMinutes()` (`usage/meter.ts`) records wall-clock agent minutes with `idempotencyKey = {workspaceId}:{scanId}:{phase}`, converts ms → integer minutes (ceiling, min 1), applies the Deep 3× multiplier, and atomically decrements `MinutePack.remainingMinutes` when consumption spills into packs. `grantMonthlyPool()` (`usage/grants.ts`) grants the monthly pool with `idempotencyKey = {workspaceId}:{periodStart}:{plan}`; for annual subscriptions it is called monthly. `creditTopUp()` (`usage/packs.ts`) creates a `MinutePack` row with 180-day expiry, idempotent on `(workspaceId, externalId)`. `expirePacks()` (`usage/expiry.ts`) is a scheduled job that zeros `remainingMinutes` on expired packs (rows kept for audit). `debitOverage()` (`usage/overage.ts`) debits Team-plan overage at $0.15/min with serializable isolation to prevent TOCTOU. `reverseRefund()` (`usage/refund.ts`) zeros entitlements on refund, idempotent on refund external ID.
- **Entitlement gating (`packages/billing/src/entitlements.ts`).** `assertScanAllowed(workspaceId, mode)` blocks DEEP/CUSTOM on TRIAL and STARTER, requires remaining agent-minutes > 0, enforces trial scan-frequency throttle, and checks overage budget for Team with spend limit. Called at scan creation in `apps/web/src/app/api/scans/route.ts`. `assertTargetAllowed()` enforces target caps (hard for trial, advisory for paid). `getGraceState()` returns grace state for the worker mid-scan.
- **Grace period (`packages/billing/src/grace.ts`).** When a workspace's balance crosses ≤ 0 mid-scan, the in-flight scan continues drawing from a bounded `graceUsedMs` counter (cap 15 min = 900,000 ms per cycle). Unused grace evaporates (never banked). Grace does not apply to scans started when balance was already ≤ 0 (those are blocked at admission). The Deep 3× multiplier still applies to grace consumption.
- **Subscription sync (`packages/billing/src/sync.ts`).** `syncSubscription()` maps provider states to workspace billing state: active → update plan + grant monthly pool + reset grace; canceled/past_due → keep plan until period end, then downgrade to FREE; trialing → set trial state. All changes are wrapped in a single transaction and audit-logged.
- **UsageRecord kinds.** `pool_grant` (monthly pool), `trial_grant` (trial 100 min), `agent_minutes` (consumption), `overage_minutes` (Team overage), `refund_reversal` (refund reversal). Pack purchases create `MinutePack` rows (not UsageRecords). All metered/grant events set `idempotencyKey` to prevent double-billing on retries.

## §73 — BYOK Local/Desktop app and license server (2026-08-18 to 2026-08-20, Sprint 10 Track B)

- **Tauri v2 desktop app (`apps/desktop`).** Rust 1.77+ core with a React 19 + Vite + Tailwind v4 webview frontend. Identifier `ai.lyrashield.desktop`, version 0.1.0. The Rust core handles license verification (ed25519), BYOK credential management (OS keychain via `keyring` crate), engine + Docker detection, scan lifecycle (spawn engine, stream progress via Tauri events), update eligibility gating, and optional cloud sync. The frontend has six screens: `ActivationScreen` (license key entry), `SetupScreen` (runtime detection + BYOK provider picker), `ScanScreen` (target + mode selection), `ScanProgressScreen` (real-time event streaming), `LicenseStatusScreen`, and `SyncScreen` (cloud sync setup).
- **License signing and verification (`packages/licenses`).** ed25519 signing via Node.js crypto (`src/sign.ts`) and verification (`src/verify.ts`). `canonicalJSON()` produces lexicographic-key-sorted, no-whitespace canonical JSON for deterministic signing. `signLicense()` returns a `LicenseFile` with base64 signature. `encodeLicenseBlob()` returns `<base64(payload)>.<base64(signature)>`. `verifyLicense()` validates payload semantics before signature verification (B-L04 fix). `isBuildInstallable()` checks perpetual fallback: if eligible, any version allowed; if expired, only builds ≤ `perpetualFallbackBuild` allowed. A golden-license test vector (`src/golden-license.json`) ensures cross-platform (Rust ↔ JS) verification parity.
- **License types.** `LicenseSku`: `individual_launch`, `individual_regular`, `team_perpetual`, `team_subscription`, `renewal`, `sync_addon`. `LicensePayload`: sku, seatCount, machineIds[], updateEligibleUntil (ISO-8601), perpetualFallbackBuild. Individual licenses allow up to 3 machines; team licenses are per-seat.
- **License server endpoints.** `POST /api/licenses/activate` (`apps/web/src/app/api/licenses/activate/route.ts`): rate-limited per IP, hashes the license key, looks up via system Prisma (workspace-less), checks revocation, enforces machine cap with `SELECT FOR UPDATE` lock, issues signed license file. `POST /api/licenses/verify` (`apps/web/src/app/api/licenses/verify/route.ts`): checks revocation status and returns update eligibility. `POST /api/licenses/issue` (admin/server-side): issues a signed license for a Polar Local-SKU order.
- **Azure Key Vault integration (`apps/web/src/lib/licenses/license-service.ts`).** Production signing uses Azure Key Vault via managed identity (`DefaultAzureCredential`). `resolveSigningPrivateKey()` fetches the private key from Key Vault in production; falls back to `LICENSE_SIGNING_PRIVATE_KEY` env var in dev/CI. Fails closed if vault unreachable. Key Vault `lyrashieldprodsecrets` contains `license-signing-private-key`, `license-signing-public-key`, `license-signing-key-id`. See `docs/ops/license-signing-keys-runbook.md`.
- **Cloud sync endpoints.** `POST /api/sync/connect` (`apps/web/src/app/api/sync/connect/route.ts`): links a Local license to a workspace; verifies key possession (H-01), checks sync entitlement (sync_addon SKU OR team_subscription OR Cloud plan), prevents license hijacking. `POST /api/sync/findings` (`apps/web/src/app/api/sync/findings/route.ts`): batches findings (max 500) from desktop to cloud; enforces cursor monotonicity (B-M03); finding IDs namespaced as `local:{licenseId}:{externalId}`; handles 409 CURSOR_REWIND by adopting server cursor.
- **Offline grace and perpetual fallback.** The desktop app stores the signed license file locally (`~/Library/Application Support/LyraShield/license.json` on macOS). On start, Rust loads the file, verifies the ed25519 signature against the bundled public key, and checks `updateEligibleUntil`. If valid, the app runs without network. Only revocation requires server contact. After the 1-year update window expires, the app keeps running the last eligible build indefinitely (perpetual fallback); it just stops accepting newer updates. Revoked licenses never ride perpetual fallback (RISK-B1).
- **BYOK providers.** ChatGPT/OpenAI subscription sign-in (OAuth) delegated to `lyrashield auth login chatgpt` (engine CLI, runs record `cost: 0`). Azure OpenAI subscription: API key + endpoint stored in OS keychain. Local/self-hosted models are deferred (engine requires GPT-5.6 Terra/Luna today). The app contains no embedded LyraShield model keys.
- **Desktop release pipeline (`.github/workflows/release-tauri.yml`).** Triggers on `v*` tags. macOS universal DMG build (aarch64 + x86_64) with Apple Developer ID signing + notarization. Windows x64 NSIS installer with code signing. Engine revision pinned (`1f911b6aa0ad5ea78db80dfaa1ec7cf1e56619f0`) with immutability verification. Signed `latest.json` updater manifest published to GitHub Releases. See `docs/ops/desktop-release-runbook.md`, `docs/ops/desktop-installation.md`, `docs/ops/tauri-updater-keys-runbook.md`.
- **Design doc.** `docs/plans/2026-08-20-local-desktop-design.md` documents the full architecture, data flows, threat model, PR sequence (#364 → #365 → #366), and acceptance criteria.

## §74 — Affiliate & partner program (2026-08-18, Sprint 10 Track C)

- **Commission engine (`packages/affiliate/src/commission/`).** `engine.ts` processes Cloud subscription commissions: 25% recurring (BASE_RATE_BPS=2500) for 12 months, 30% at 10+ active referrals (TIER_RATE_BPS=3000, TIER_THRESHOLD=10). Annual plans pay flat 25% (ANNUAL_RATE_BPS=2500) — the tier kicker applies to monthly only (founder-confirmed 2026-08-19). Commission base = net (pre-tax, after discounts), snapshotted per commission. Decimal(19,4) precision. `local.ts` handles Local-license one-time commissions at 20% (LOCAL_RATE_BPS=2000). `clawback.ts` reverses commissions on refunds/chargebacks: updates in place (status → REVERSED, amount → 0), idempotent, manual review for >$200. `release.ts` is a scheduled job moving PENDING → AVAILABLE when `availableAt` passes.
- **Attribution (`packages/affiliate/src/attribution/`).** Precedence: promo code > last-click cookie > unattributed. `resolve.ts` resolves attribution at checkout/signup. `cookie.ts` manages the first-party `__ls_aff` cookie (opaque random token, not JWT; Max-Age 60 days = 5,184,000 seconds; Secure, HttpOnly, SameSite=Lax, Domain=.lyrashieldai.com). `middleware.ts` detects `?ref=CODE` and `/r/:code` paths, validates the affiliate link + status, creates a `Click` record (async, non-blocking), sets the cookie, and creates an `AttributionToken` with 60-day expiration. `signup.ts` attributes new users, rejects self-referrals (userId + email comparison), and marks tokens as consumed.
- **Fraud controls (`packages/affiliate/src/fraud/`).** `signals.ts` detects disposable emails (10 domains), rate limits >5 signups per IP and >3 per device (high severity), and device fingerprint duplicates. `selfreferral.ts` catches self-referrals by userId and email (case-insensitive, C-L06).
- **Payout ledger (`packages/affiliate/src/payout/`).** `request.ts` transactionally locks AVAILABLE commissions (`SELECT...FOR UPDATE`), marks RESERVED, creates `Payout` + `PayoutItem[]`, calls the provider, and on failure releases back to AVAILABLE. UUID idempotency key (C-M07 fix). `eligibility.ts` checks: available ≥ $100 minimum, valid payout method, tax form complete (W-9/W-8BEN/W-8BEN-E/GSTIN), no active pending/processing payouts. `scheduler.ts` runs monthly on the 15th (net-30). `reserve.ts` applies a 25% new-affiliate reserve for 90 days. `reserve-release.ts` is a scheduled job that creates reserve-release payouts for affiliates past the reserve window, idempotent via `reserveReleasedAt` check.
- **Payout providers.** RazorpayX (`providers/razorpayx.ts`) for India (INR, IMPS/UPI). Payoneer (`providers/payoneer.ts`) for global (USD, EUR, Mass Payouts API). BriskPe (`providers/briskpe.ts`) as RBI-native fallback. Trolley (`providers/trolley.ts`) optional at scale for tax automation. All are stub implementations (API calls commented out) — provider-agnostic ledger routes by affiliate region.
- **Affiliate dashboard (`apps/web/src/app/affiliates/`).** Public: `/affiliates` (program landing with terms), `/affiliates/apply` (application form with CSRF protection, fraud signal detection, binding terms acceptance at `AFFILIATE_TERMS_VERSION = "2026-08-18-v1"`). Partner: `/affiliates/dashboard` (KPI cards: clicks, signups, conversions, active referrals, commission status breakdown, tier progress, date filter), `/affiliates/links` (referral link + promo code + campaign variants), `/affiliates/commissions` (immutable ledger, last 200), `/affiliates/payouts` (balance cards, reserve status, payout request, method/tax form config, history), `/affiliates/activity` (clicks/conversions tabs). Admin: `/admin/affiliates` (approval queue, tier override, payout approval, fraud review).
- **Webhook dispatch (`packages/affiliate/src/webhook-dispatch.ts`).** Routes `order.paid`/`subscription.paid` to `onOrderPaid()` (Cloud) or `onLocalOrderPaid()` (Local SKU), skips minute-pack orders (no commission), and routes `order.refunded`/`chargeback.created` to `onRefund()`. Non-blocking on failure. Called from the billing webhook route after Track A processing.
- **Program terms (`packages/affiliate/src/index.ts`).** BASE_RATE_BPS=2500, TIER_RATE_BPS=3000, LOCAL_RATE_BPS=2000, ANNUAL_RATE_BPS=2500, TIER_THRESHOLD=10, DEFAULT_RESERVE_PCT=25, DEFAULT_RESERVE_DAYS=90, DEFAULT_MIN_PAYOUT_USD=100, PAYOUT_DAY_OF_MONTH=15, CLOUD_REFUND_WINDOW_DAYS=14, AFFILIATE_TERMS_VERSION="2026-08-18-v1". No commission on minute packs, trial signups, or self-referrals. No lifetime deals.

## §75 — Agent plugin v0.1.17 and agent-registry expansion (2026-08-10 to 2026-08-20)

- **Agent plugin v0.1.17 (`packages/agent-plugin`).** Cursor shim now uses `streamable-http` transport (OAuth-first, no API key in manifest) pointing to `https://app.lyrashieldai.com/api/mcp`. Kiro shim also made OAuth-first (separate `.mcp.kiro.json` for stdio). Generated skill includes mode/cost guide, example prompts, and minute-awareness. Marketplace catalog flattened to root with `plugin.json`, `mcp.json`, and `skills/` together. `buildPlugin()` generates `plugin/skills/lyrashield/SKILL.md` from `@lyrashield/agent-rules` policy and emits client manifest shims for 4 confirmed clients: Claude Code, Cursor, OpenAI Codex, Kiro.
- **Agent registry (`packages/agent-registry`).** 30 entries covering 24 distinct agents across 4 install strategies: config-file, guided-manual, vendor-cli, agent-plugin. 6 clients have reserved `agent-plugin` entries (Claude Code, Cursor, VS Code, OpenAI Codex, GitHub Copilot, Kiro). VS Code and GitHub Copilot entries remain reserved (unverified discovery paths). The `<apiUrl>` placeholder resolves to the Streamable-HTTP MCP endpoint (`<apiUrl>/api/mcp`).

## §76 — Sprint 10 closeout and operations runbooks (2026-08-18 to 2026-08-20)

- **Sprint 10 closeout evidence (PR #363).** `docs/ops/` runbooks record the Sprint 10 three-track build provisioning, ed25519 key generation, Azure Key Vault storage, GitHub Actions secrets, and live verification evidence. The Key Vault `lyrashieldprodsecrets` contains the license signing keypair; a smoke test (`POST /api/licenses/issue` + `POST /api/licenses/verify`) returned `valid: true`.
- **License signing keys runbook (`docs/ops/license-signing-keys-runbook.md`).** ed25519 key generation, Key Vault storage, key rotation, and compromise procedures. Container App managed identity principal: `c31f949b-e297-4cb9-8605-06cde5b744aa`.
- **Desktop release runbook (`docs/ops/desktop-release-runbook.md`).** Tagging, building, signing, publishing, and rollback for the Tauri desktop app. Apple Developer ID + notarization setup. Windows code signing (Azure Trusted Signing or certificate). Production smoke test checklist.
- **Desktop installation guide (`docs/ops/desktop-installation.md`).** Prerequisites (engine CLI, Docker Desktop, AI provider), macOS and Windows installation steps, first-run setup (activation, BYOK configuration), offline grace explanation, optional cloud sync setup, privacy and troubleshooting.
- **Tauri updater keys runbook (`docs/ops/tauri-updater-keys-runbook.md`).** Tauri updater keypair generation on an offline workstation, dual backup (Azure Key Vault + offline hardware token), GitHub Actions secrets provisioning, key rotation and loss recovery.
- **License RLS live verification (`docs/ops/license-rls-live-verification.md`).** Live-DB RLS verification for the License NULL-workspaceId fix (B-L08), mirroring CI invariants against the production database.
- **Removed planning briefs.** `BYOKapp.md`, `affliate.md`, and `sprint10.md` were the founder-confirmed dev-ready briefs for the three Sprint 10 tracks. Their content has been migrated into this document (§§71–74), `PRD.md` Part C, and `monetization.md`. The briefs themselves were removed from the repo root after migration.

## §77 — Production recovery and egress hardening (2026-08-21)

- **Restore proof (PR #377).** The production backup workflow now generates the Prisma client before starting the isolated restored application. The 2026-08-21 manual run completed encrypted backup, PostgreSQL archive restore, schema/RLS/audit-chain verification, and application startup.
- **Worker-only egress proxy (PR #376).** `Dockerfile` builds a non-root `egress-proxy` runtime target and `deploy-azure.yml` publishes a SHA-tagged proxy image, retains its recent tags, and updates the proxy app whenever `AZURE_EGRESS_PROXY_CONTAINER_APP_NAME` is configured. The deployed Container App runs the verified digest, uses a system-managed identity with a Key Vault secret reference, and allows ingress only from the dedicated worker VM. The worker refresh path now supplies the proxy URL/secret and DNS-pins the endpoint; an external proxy health request receives `403`.
- **Managed TLS Redis and negative egress proof completed.** PR #380 moved BullMQ to the authenticated Upstash `rediss://` TCP endpoint while keeping the REST URL/token exclusive to rate limiting; PR #381 persists the scanner binding and uses the existing expiring heartbeat because managed Redis proxies do not reliably expose other clients' BullMQ names. Worker digest `sha256:3adcd2c67ff86dda960851c85799a10e0f42553d49a13d5a0a18a32f01363f49` runs product revision `65ad8119d1401cdad672d7122acdc0fc4ee7cf94` with engine `dd588c379ae6614e0914b8adb41d94f0c1e86c26`. The cutover recorded `PONG`, zero queued/active jobs, one live worker heartbeat, removal of the Internet-facing Azure `6379` NSG rule, and a stopped/restart-disabled legacy Redis container retained for rollback. The live worker proof denied a direct public fetch, allowed the authenticated proxy path, and denied loopback with `ssrf_blocked`. Literal private-network Redis remains an enterprise topology option.
