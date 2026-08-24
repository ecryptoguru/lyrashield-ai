# LyraShield AI — Codebase Guide

> Current implementation map: 2026-08-21. Read [AGENTS.md](./AGENTS.md) first for the immediate handoff and rules; use [PRD.md](./PRD.md) for product scope and release gates. Running code, Prisma schema, migrations, CI, and live evidence override this guide.

## 1. System overview

LyraShield AI is a multi-tenant release-assurance platform for repositories, deployed web apps, and APIs.

```text
Target → Scan → Evidence State → Fix Proposal → Retest → Assurance Report
```

Repository boundary:

- `lyrashield-ai` (this monorepo): product UI/API, auth, tenancy, billing, orchestration, deterministic scanners, findings, evidence, reports, MCP/CLI/plugin, Local/Desktop, marketing, and deployment automation.
- `lyrashield-engine` (sibling Python repo): controlled derivative over pinned Strix v1.5.3. Worker invokes the `lyrashield` CLI as a subprocess; TypeScript never imports engine internals.
- `lyrashield-marketplace` (sibling repo): published generated install artifacts. Generation source remains in this monorepo.

Public name is **LyraShield AI**. Do not rename `@lyrashield/*`, `LYRASHIELD_*`, database/container identifiers, or engine CLI without founder approval.

## 2. Stack

| Layer      | Technology                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| Web/API    | Next.js 16 App Router, React 19, TypeScript 6                                                                       |
| UI         | Tailwind CSS 4, shared `@lyrashield/ui`, Lucide                                                                     |
| Auth       | Better Auth                                                                                                         |
| Validation | Zod 4                                                                                                               |
| Database   | PostgreSQL, Prisma 7 with `@prisma/adapter-pg`, RLS                                                                 |
| Queue      | BullMQ over Redis                                                                                                   |
| Worker     | Node/TypeScript plus Python engine subprocess and Docker sandbox                                                    |
| Desktop    | Tauri v2, Rust, React/Vite                                                                                          |
| Marketing  | Astro 7 on Cloudflare Workers, D1, KV, Rate Limits                                                                  |
| Testing    | Vitest, Playwright, Node test, Rust/Cargo checks                                                                    |
| Build      | pnpm workspaces, Turborepo, Docker, GitHub Actions                                                                  |
| Production | Azure Container Apps, dedicated Azure worker VM, Supabase/PostgreSQL, Upstash, Cloudflare, R2/S3-compatible storage |

Version rules:

- Prisma client is generated and gitignored; run `pnpm db:generate` after schema changes.
- Prisma 7 connection uses `PrismaPg`; datasource URL is configured through `prisma.config.ts`.
- Zod 4 uses `z.url()` and `z.email()`.
- Tailwind 4 is CSS-first; there is no `tailwind.config.js`.
- Brand icons come from shared UI, not Lucide.

## 3. Repository map

### Applications

| Path                    | Responsibility                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`              | Authenticated Next.js app, REST APIs, public reports/scorecards, OAuth/MCP endpoints, billing, licenses, affiliates, sync |
| `apps/worker`           | BullMQ worker, preflight, schedules, deterministic scanners, engine runner, evidence/results, accounting                  |
| `apps/desktop`          | Tauri Local/Desktop app, license verification, BYOK keychain, local scans, sync, updater                                  |
| `apps/marketing`        | Astro/Cloudflare marketing, blog, public tools, waitlist/referrals, Lite Scanner frontend                                 |
| `apps/marketing-motion` | Deterministic Three.js marketing media production                                                                         |

### Shared packages

| Package            | Responsibility                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `auth`             | Better Auth server/client split, sessions, permissions, OAuth workspace binding           |
| `db`               | Prisma schema/migrations/client, RLS/scoping, audit chain, domain services                |
| `types`            | Zod schemas, DTOs, enums, queue/action/scan contracts, OpenAPI exports                    |
| `ui`               | Accessible shared controls, cards, forms, dialogs, themes, loading/empty states           |
| `config`           | Environment schemas and shared TypeScript/ESLint configuration                            |
| `logger`           | Structured, circular-safe, truncating, secret/PII-redacting logs                          |
| `integrations`     | GitHub, Redis, shared queue, notifications, external providers                            |
| `security`         | SSRF-safe fetch, public-surface analysis, AI security scanner, prompt/input controls      |
| `egress-proxy`     | Authenticated DNS-pinned SSRF-safe URL fetching                                           |
| `score`            | Pure versioned LyraShield Score calculation and eligibility rules                         |
| `billing`          | Polar/Razorpay gateways, entitlements, trial, usage, packs, grace, overage, sync          |
| `pricing`          | Cloud plans, minute packs, Local SKUs                                                     |
| `licenses`         | ed25519 license signing/verification and canonical JSON                                   |
| `affiliate`        | Attribution, commissions, fraud checks, payouts, reserves, webhook dispatch               |
| `evidence-storage` | AES-256-GCM envelope encryption and private storage abstraction                           |
| `mcp`              | API-backed MCP server, stdio transport, tool schemas, prompt-injection guard              |
| `sdk`              | Authenticated API client used by CLI and MCP                                              |
| `credentials`      | Single source for `~/.lyrashield/credentials.json`, env precedence, API URL normalization |
| `cli`              | Canonical unscoped `lyrashield` CLI                                                       |
| `cli-alias`        | Deprecated `@lyrashield/cli` compatibility wrapper                                        |
| `agent-registry`   | Install metadata for supported coding agents                                              |
| `agent-rules`      | Agent policy/rule/skill rendering                                                         |
| `agent-plugin`     | Portable plugin, MCP descriptor, skill, and client shims                                  |

Generated output—`.next`, `dist`, `.turbo`, `.astro`, `.wrangler`, motion renders, media-local, Prisma generated client, `node_modules`, and `*.tsbuildinfo`—is not source.

The former `packages/eval-ai-safety` runner was removed as unused in `b96e597`. Its recorded 2026-08-13 result artifact remains at `apps/marketing/src/data/ai-safety-results.json` and is rendered by `apps/marketing/src/pages/ai-safety.astro`; rerunning that historical benchmark requires restoring or replacing the runner. The separate fixed, non-destructive live AI safety catalog is tracked in `packages/types/src/ai-safety-tests.ts` and documented in `docs/ai-safety-test-pack.md`.

## 4. Runtime architecture

### Web request

```text
Request
  → proxy: nonce CSP, client-IP trust, rate limit
  → Better Auth session
  → workspace membership + permission
  → Zod validation
  → workspace-scoped Prisma service / withWorkspaceRLS
  → audit event for sensitive mutation
  → typed success/error response
```

Protected routes use `{ success: true, data }` or `{ success: false, error: { code, message } }`. Lists use cursor pagination. Client code reuses `apiGet`, `apiPost`, `apiPatch`, `apiDelete`, and `apiGetPaginated` rather than ad hoc fetch wrappers.

### Repository scan

```text
POST /api/scans
  → assertScanAllowed
  → worker heartbeat check
  → serialized Scan row creation
  → shared enqueueScan
  → BullMQ worker preflight
  → isolated checkout/workspace
  → rules of engagement
  → deterministic scanners + controlled engine subprocess
  → normalize and deduplicate
  → upload evidence
  → persist candidates, receipts, manifest, findings, usage
  → score, notifications, terminal state
```

Only repository targets invoke the external engine. URL/API targets use deterministic, profile-bound scanners until an equivalent engine transport contract exists.

### URL/API scan

- Target creation performs SSRF validation.
- Fetch time resolves, validates, pins, and revalidates each redirect.
- Production URL fetching uses authenticated `packages/egress-proxy`.
- Profiles bound documents, depth, bytes, concurrency, methods, origin probes, and wall time.
- API Standard/Deep require validated public HTTPS OpenAPI input.

### Local/Desktop scan

```text
Signed license verification
  → runtime/engine/Docker detection
  → BYOK credential from OS keychain
  → local engine and sandbox
  → local findings
  → optional authenticated Cloud Sync
```

No source, findings, or credentials sync unless user opts in.

## 5. Core contracts

### Auth and RBAC

Client-safe imports come from `@lyrashield/auth`; server-only imports come from `@lyrashield/auth/server`.

Role order:

```text
OWNER > ADMIN > SECURITY_ADMIN > APPSEC_MANAGER > BILLING_ADMIN
      > DEVELOPER > MEMBER > EXTERNAL_PENTESTER > AUDITOR > VIEWER
```

Permission groups cover workspace, member, project, target, scan, finding, fix, retest, report, notification, schedule, policy, audit, billing, integration, and agent actions.

Platform administration is intentionally outside this workspace role order:

- `packages/config/src/platform-admin.ts` owns the exact-two email allowlist and rejects missing, duplicate, aliased, or expanded configuration.
- `packages/auth/src/session.ts` accepts only a browser-cookie identity that is allowlisted, email-verified, `PLATFORM_OPERATOR`, TOTP-enabled, and recently TOTP-stamped. Bearer credentials are rejected.
- `packages/db/src/platform-admin-security.ts` owns challenge rate limiting, action-specific single-use elevation nonces, transaction-time authority revalidation, and atomic `PlatformAdminAudit` creation.
- `apps/web/src/app/(dashboard)/dashboard/admin` contains noindex overview/users/workspaces/scans/audit/affiliate read surfaces. Unauthorized access resolves to not found.
- `packages/db/scripts/provision-platform-admins.ts` and `.github/workflows/provision-platform-admins.yml` provide read-only preflight and explicitly confirmed apply. Apply revokes existing sessions/elevations for both operators and writes the bootstrap audit receipt.
- Affiliate admin writes currently return `ADMIN_ACTION_DISABLED`; do not document the console as a general mutation surface until the atomic write boundary is connected.

### Tenancy and RLS

- Every workspace query explicitly carries `workspaceId`.
- `AsyncLocalStorage` provides request-safe workspace context.
- `withWorkspaceRLS(workspaceId, fn)` uses transaction-local DB context.
- `SOFT_DELETE_MODELS` contains only models with `deletedAt`.
- `WORKSPACE_SCOPED_MODELS` contains only directly scopable models with `workspaceId`.
- Child tables are scoped through parents and protected by fail-closed RLS policies.
- Production runtime role must be neither superuser nor `BYPASSRLS`.

### Audit chain

Use `prisma.auditLog.create()` through the extended client. Its advisory-locked transaction owns `prevHash`/`hash` serialization. Do not place audit creation inside a broader transaction. Any mutation of hashed audit fields requires a locked chain rebuild.

### Queue and lifecycle

- Queue authority: `packages/integrations/src/queue.ts`.
- Use `getScanQueue()` and `enqueueScan()`; never instantiate one-off queues.
- Admission checks worker readiness before Scan creation and again at enqueue.
- Worker heartbeat lease refreshes every 10 seconds and expires after 30 seconds.
- Queue/database orphans fail after five minutes and are never auto-replayed.
- Status changes go through guarded transitions, not direct updates.
- Worker cancellation terminates registered engine processes and preserves auditable state.

Lifecycle:

```text
QUEUED → PREFLIGHT → RUNNING → VERIFYING → COMPLETED
```

Alternatives: `FAILED`, `CANCELLED`, `TIMED_OUT`, `STOPPED_BUDGET`, `REQUIRES_APPROVAL`.

### Engine boundary

- Product code lives in engine `lyrashield/**` and `lyrashield_adapter/**`; upstream `strix/**` retains only hard-gated generic seams.
- Stable upstream releases enter through reviewed PRs; never force-push or auto-resolve conflicts.
- Worker builds engine from sibling repo using named Docker context.
- `lyrashield --version`, immutable app/engine OCI labels, and digest reconciliation are image gates.
- CLI exit `0` means completed/no findings; `2` means completed/findings; other nonzero means runtime/config failure.
- Output artifact reads and parsed fields are bounded. Raw stdout/stderr and raw engine output are not persisted.

### Model routing and accounting

Authorities:

- `apps/worker/src/engine/runner.ts`: `resolveEngineProfile()`.
- `apps/worker/src/engine/command-builder.ts`: `resolveScanBudgetUsd()`.
- `apps/worker/src/engine/gpt56-pricing.ts`: versioned rate card.

Safe/Quick/Standard use Luna/medium. Deep/Custom use Terra/medium root plus Luna/high specialists. The fallback model remains mandatory and policy values may only lower caps. Private receipts preserve actual model, requests, token buckets, cache reads/writes, long-context usage, provider cost, billed cost, and reconciliation status.

### Findings and result integrity

- `confidence` never sets `verified`.
- Engine and scanner output create bounded candidates and receipts.
- Evidence must use `uploadEvidence()` with checksum and encryption key reference.
- New claims are `DETECTED` unless trusted evidence establishes another state.
- Deterministic clean retest can produce `VALIDATED` only with complete originating coverage.
- Engine-only retest absence remains `INCONCLUSIVE`.
- Direct `FIXED` becomes `FIXED_PENDING_RETEST` until server-owned retest evidence exists.
- Manifest is finalization checkpoint; retry resumes scoring rather than repeating paid work.

### GitHub and approvals

- Callback state alone cannot claim an installation.
- Installation ownership must be provider-backed and bound to initiating user/workspace.
- Approval claims exact action name and input hash atomically and once.
- Fix PR route accepts no client-authored patch, branch, title, or body.
- PR execution remains disabled until a server-generated immutable patch/evidence artifact is approval-bound.

### Public sharing

- `buildScorecardPayload()` is the only public scorecard constructor.
- Public payload excludes target URLs, repository identity, findings, raw IPs, user agents, and captions.
- Scorecard events accept strict event/channel/source variants only.
- Reports use immutable snapshots; revoked or expired shares return 404.
- Public wording says detected, retest-confirmed, verified, or inconclusive precisely.

## 6. Domain maps

### Billing

Primary locations:

- `packages/pricing`: plan and SKU truth.
- `packages/billing/src/providers`: Polar/Razorpay adapters.
- `packages/billing/src/usage`: balance, meter, grants, packs, expiry, overage, refund.
- `packages/billing/src/entitlements.ts`: scan/target admission.
- `apps/web/src/app/billing`: checkout, webhook, portal, UI.

Billing webhook inserts `WebhookEvent` before synchronous Track A/B/C processing. Money uses `Decimal(19,4)`, never Float. Usage, pack purchase, subscription, refund, commission, and payout operations are idempotent. Agent-minute recording and FIFO pack debit share one workspace advisory-locked serializable transaction; each tick debits only its incremental spill beyond the monthly pool, and conditional pack updates prevent negative balances.

### Licenses and Local/Desktop

- `packages/licenses`: canonical JSON, sign, verify, eligibility.
- `apps/web/src/app/api/licenses`: activate, issue, verify.
- `apps/web/src/app/api/sync`: connect and finding sync.
- `apps/web/src/lib/licenses/license-service.ts`: production Key Vault signing.
- `apps/desktop/src-tauri`: license, keychain, runtime, scan, sync, updater.
- `.github/workflows/release-tauri.yml`: signed/notarized releases.

Revoked licenses hard-stop. Production signing fails closed if Key Vault is unavailable.

### Affiliate

- `packages/affiliate/src/attribution`: referral cookie/promo resolution.
- `packages/affiliate/src/commission`: Cloud/Local commissions and clawback.
- `packages/affiliate/src/fraud`: disposable email, velocity, device, self-referral.
- `packages/affiliate/src/payout`: eligibility, reservations, provider routing, reserve release.
- `apps/web/src/app/affiliates`: public application, partner dashboard, admin surfaces.

Annual Cloud commission is flat 25%; 30% tier applies only to monthly. No commission on packs, trials, or self-referrals.

### Agent, MCP, CLI, and plugin

- Agent actions execute through existing API/service boundaries; there is no separate `apps/agent` runtime.
- `packages/mcp` owns tool definitions and transports.
- `packages/sdk` owns authenticated HTTP calls.
- `packages/credentials` owns stored credential semantics.
- `packages/cli` is canonical; `packages/cli-alias` is deprecated compatibility.
- `packages/agent-registry` owns client install metadata.
- `packages/agent-plugin` generates marketplace/plugin artifacts and verified client shims.

Current package/runtime contract: `lyrashield` CLI `0.2.0` supports Node 22–24; `@lyrashield/mcp` `0.2.2` and `@lyrashield/agent-plugin` `0.1.17` require Node 24+. MCP uses SDK `1.30` and Zod 4. Registry contains 30 entries and resolves 26 preferred client surfaces: 13 config-file installs, one vendor CLI, seven guided-manual clients, and five Agent Plugin installs for Claude Code, Cursor, OpenAI Codex, GitHub Copilot, and Kiro. Registry retains three legacy config-file alternatives for plugin-preferred clients. Four generated client-specific shims cover Claude Code, Cursor, OpenAI Codex, and Kiro; GitHub Copilot uses the portable root plugin manifest. VS Code stays on its verified config-file path.

Hosted OAuth is read-only by default. Write scope still requires permission and per-action approval.

### Marketing

- `apps/marketing/astro.config.mjs`: canonical origin and indexability contract.
- `apps/marketing/src/middleware.ts`: Worker response headers.
- `apps/marketing/src/pages/api/waitlist.ts`: D1 waitlist/referrals.
- `apps/marketing/src/pages/tools`: browser-local tools.
- `apps/marketing/wrangler.jsonc`: source bindings only.
- Deploy generated `apps/marketing/dist/server/wrangler.json`.
- `apps/marketing/src/pages/robots.txt.ts`, `llms.txt.ts`, `agents.md.ts`, sitemap configuration, canonical/schema helpers, comparison/research pages, and integration docs form the SEO/AEO/GEO surface. Production indexability gates crawler output; external indexing and citation still require separate receipts.

## 7. API surface

The web app currently contains 108 route-handler files. Grouped surfaces:

- auth, OAuth metadata/consent/device approval, MCP;
- workspaces, onboarding, team, account deletion;
- projects, targets, GitHub installation/repositories/webhooks;
- scans, readiness, events, cancellation, findings, retests, fix proposals;
- reports, scorecards, cards, badges, referrals, launch readiness;
- notifications and schedules;
- billing checkout/webhook/portal, usage and entitlements;
- license activation/issue/verify and Local sync;
- affiliate application, dashboard, commissions, payouts, admin;
- health, readiness, OpenAPI, and public metadata.

Trust-boundary rules:

1. Parse with Zod.
2. Authenticate unless explicitly public.
3. Resolve workspace from trusted resource/body/route data.
4. Enforce membership and permission.
5. Scope every query.
6. Record sensitive mutations.
7. Return stable typed error codes; never leak raw provider bodies or secrets.

## 8. Environment contracts

### Web and worker

- Auth: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, OAuth provider values, trusted origins.
- Database: `DATABASE_URL`, `DATABASE_DIRECT_URL`, worker-only `DATABASE_SYSTEM_URL` where required.
- Queue: `REDIS_URL`; production BullMQ requires authenticated `rediss://`.
- Rate limit: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` only.
- Engine: `LYRASHIELD_LUNA_LLM`, `LYRASHIELD_TERRA_LLM`, `LYRASHIELD_LLM`, Azure API values.
- Evidence: `S3_*` plus encryption/key references.
- Proxy: `LYRASHIELD_EGRESS_PROXY_URL`, `LYRASHIELD_EGRESS_PROXY_SECRET`.
- Email: `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION`, `BREVO_API_KEY`, sender values.
- Billing: Polar/Razorpay credentials, price maps, webhook secrets.
- License: Key Vault and signing key identifiers.
- Optional search: `LYRASHIELD_WEB_SEARCH_*`.

### Desktop

Public verification key and updater public key may ship. Private signing keys and LyraShield model keys may not.

### Marketing

Public build values select canonical site/app/scanner origins and Turnstile. Worker secrets include D1/KV/Rate Limit bindings and `WAITLIST_IP_SALT`.

Environment validation fails closed in production where a capability is required.

## 9. UI and accessibility conventions

- Reuse `@lyrashield/ui` components and semantic tokens.
- Mobile-first layout, 44px touch targets, no horizontal overflow at 320px.
- Labels use `htmlFor`/`id`; first form field gets `autoFocus` where appropriate.
- Every async surface has stable loading, empty, error, retry, and cancellation states.
- Icon-only controls have accessible names; decorative icons use `aria-hidden`.
- Dialogs trap focus, restore focus, and support Escape unless destructive confirmation requires otherwise.
- Honor reduced motion and system/light/dark preference without hydration flash.
- Server components supply initial data; client components own interaction and typed mutations.
- `DashboardExperience` stores a per-workspace `guided` or `pro` preference in local storage; storage failure preserves Guided as the fully functional default. `ProDashboardSection` changes presentation density only, never authorization, data scope, or scan behavior.
- Render and inspect real browser output for UI changes.

## 10. Commands and verification

```bash
pnpm install
pnpm db:generate
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm format:check
git diff --check
```

Database changes also require fresh migration replay, drift check, RLS tests, and additive/backward-compatible review. Worker/engine changes require image build, OCI-label/digest verification, engine controlled-derivative gate, local sandbox proof, and relevant production proof. Marketing changes require Worker-backed browser/crawl verification. Desktop changes require frontend, Rust, updater, signing/notarization checks as applicable.

Current command output is authoritative; never copy historical test counts forward as proof.

## 11. Production topology and accepted evidence

### Live topology

- `lyrashieldai.com`: Cloudflare marketing.
- `app.lyrashieldai.com`: authenticated Next.js application.
- `scanner.lyrashieldai.com`: passive Lite Scanner.
- managed PostgreSQL with RLS runtime role.
- Upstash TLS TCP Redis for BullMQ.
- dedicated Azure worker VM running immutable digest.
- worker-only authenticated egress proxy.
- S3/R2-compatible evidence layer; full production private-evidence proof remains a gate.

### Current worker proof

- Product revision: `8347fda923032960661079491a0a17956aebefd9`.
- Engine revision: `944a84f15f913909039c89146c25db650cd87137`.
- Worker digest: `sha256:6f73ad5e1125fffd8b4eec85103d14b49eb0c6a1765cab29a1a5edb3d7a17413`.
- Container Apps: app `lyrashield-app--0000170`, scanner `lyrashield-scanner--0000151`, and egress proxy `lyrashield-egress-proxy--0000020` at 100% traffic; release run `32738811470` and public readiness passed.
- BullMQ Redis: TLS/authenticated `PONG`, live heartbeat, empty queue before acceptance.
- Azure public `6379`: removed.
- Legacy Redis: stopped, restart-disabled, rollback-only.
- Egress: direct public denied, proxy public allowed, loopback denied `ssrf_blocked`.
- DNS refresh timer: active during Standard scan; no worker restart.
- Backup/restore: encrypted backup, isolated restore, schema/RLS/audit/app startup verified.
- Code ahead of production: `main` is `80460f80d32f42e1a647eed180be6a3fa9f4bf51` with green CI. Release `32755678337` pushed images but failed the production provider-mode guard before Azure login, migrations, revision creation, or runtime mutation. Those images are not deployed. Production remains on the exact worker proof above with purchase admissions `off`.

### Current Standard scan proof

- Scan `cmt35aj1s000001hck9fmguzk`.
- `OnboardingAI2` revision `1689f3607d68764e09769535df8e368c4d5ad2fe`.
- Completed in 11m 42s.
- 184 Luna/medium requests; no Terra.
- 8,227,004 input, 6,066,725 cached input, 30,844 output tokens.
- `$0.597148` provider and billed cost under `$3.20` cap.
- 24 findings/candidates/verification receipts, 56 coverage receipts, zero independently verified.
- AI App Security reached 200-file bound.
- 12 agent-minutes debited.

This is target/revision-scoped runtime and accounting proof, not a security guarantee.

### AI App Security coverage remediation

- `ai-app-security.ts` ranks production/config sources ahead of tests and fixtures, excludes generated artifacts, and applies explicit mode caps: Quick/Safe 200, Standard 500, Deep/Custom 1,000.
- Discovery produces structured eligible/scanned/skipped/byte counts, skip reasons, limit codes, and a bounded representative skipped-path sample.
- `scanner-orchestrator.ts` merges discovery limits into AI scoring and provenance. `result-integrity.ts` persists the `ai_app_security` family receipt in manifest v4, preventing bounded AI coverage from becoming a complete clean claim.
- The scan-detail UI shows coverage counts and skipped-path samples instead of only the legacy one-line warning.
- Regression coverage uses an exact 217-file repository: Quick scans 200 and reports 17 skipped while retaining vulnerable production code; Standard scans all 217. Generated directories are excluded.
- PR #386 merged as `8ee6fd5`; its coverage remediation remains in the current product. Production now runs product `8347fda9` at app revision `lyrashield-app--0000170` and worker digest `sha256:6f73ad5e1125fffd8b4eec85103d14b49eb0c6a1765cab29a1a5edb3d7a17413`. The prior acceptance scan remains historically bounded and unchanged.

## 12. Key files

| File                                             | Purpose                                                      |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `apps/web/src/proxy.ts`                          | CSP, rate limit, trusted client IP                           |
| `apps/web/src/lib/api-client.ts`                 | Typed client requests                                        |
| `apps/web/src/lib/api-response.ts`               | Typed server responses                                       |
| `apps/web/src/app/api/scans/route.ts`            | Scan admission and creation                                  |
| `apps/web/src/app/billing/webhook/route.ts`      | Polar/Razorpay idempotent webhook boundary                   |
| `apps/web/src/lib/licenses/license-service.ts`   | Production signing boundary                                  |
| `apps/worker/src/jobs/run-scan.job.ts`           | End-to-end scan orchestration                                |
| `apps/worker/src/engine/runner.ts`               | Bounded/cancellable engine subprocess                        |
| `apps/worker/src/engine/command-builder.ts`      | Engine arguments and budget policy                           |
| `apps/worker/src/engine/gpt56-pricing.ts`        | Versioned GPT-5.6 rate card                                  |
| `apps/worker/src/engine/scanner-orchestrator.ts` | Deterministic and engine result merge                        |
| `apps/worker/src/engine/result-integrity.ts`     | Manifest/candidate/receipt boundary                          |
| `packages/integrations/src/queue.ts`             | Shared queue authority                                       |
| `packages/db/prisma/schema.prisma`               | Executable data model                                        |
| `packages/db/src/scoping.ts`                     | AsyncLocalStorage and scope policy                           |
| `packages/db/src/rls.ts`                         | Transaction-local RLS context                                |
| `packages/db/src/scan-transitions.ts`            | Lifecycle guards                                             |
| `packages/db/src/score-service.ts`               | Score persistence/public payload boundary                    |
| `packages/security/src/safe-fetch.ts`            | Redirect-safe pinned fetch                                   |
| `packages/mcp/src/prompt-injection-guard.ts`     | Model-input guard                                            |
| `ops/worker/*`                                   | Worker VM services, secrets, egress, promotion, verification |
| `.github/workflows/ci.yml`                       | Main release gate                                            |
| `.github/workflows/deploy-azure.yml`             | Migration-first Azure deployment                             |

## 13. Landmines

1. Never push directly to `main`; use focused branch and PR.
2. Never replace AsyncLocalStorage workspace context with module state.
3. Never add a model to scope/soft-delete sets without matching columns.
4. Never use superuser or `BYPASSRLS` runtime DB credentials.
5. Never write audit events inside a larger transaction.
6. Never create `Evidence` without `uploadEvidence()`, checksum, and encryption key reference.
7. Never interchange BullMQ `REDIS_URL` with Upstash REST rate-limit credentials.
8. Never trust proxy headers unless ingress strips and overwrites them.
9. Never invoke repository engine for URL/API targets.
10. Never persist raw engine output or trust model confidence as verification.
11. Never auto-requeue ambiguous paid work or delete BullMQ keys directly.
12. Never accept client-authored GitHub patch/branch/title/body.
13. Never process Polar/Razorpay webhook before idempotent event insertion.
14. Never use Float for money; use `Decimal(19,4)`.
15. Never allow revoked license perpetual fallback.
16. Never put private target/finding/user data in public scorecard analytics.
17. Never deploy marketing from source `wrangler.jsonc`; use generated config.
18. New production migrations are additive and forward-only; container rollback does not reverse schema.
19. Keep Brevo binding while email verification is required.
20. Keep engine upstream imports review-gated; no mechanical rebrand or force-push.

## 14. Compact implementation ledger

- **2026-07-04 to 07-06:** foundation, auth/tenancy, UI/DX, RLS, queue, engine boundary, findings, SCA, secrets, URL scanning, reports, schedules, notifications, MCP, approvals.
- **2026-07-10 to 07-15:** tenant/reliability hardening, controlled engine ownership, scorecards/referrals, GPT-5.6 routing, result manifests/receipts, evidence-backed copy.
- **2026-07-16 to 07-18:** Cloudflare launch, Lite Scanner, production marketing, PostHog, accounting, fail-closed queue admission/recovery.
- **2026-07-24 to 08-03:** CLI/agent distribution, UX V2, migration-first Azure deploys, RLS reproduction, worker recovery and digest integrity.
- **2026-08-04 to 08-13:** Parallel Search, OAuth/MCP marketplace, URL/API profiles, reproducible engine releases, claims map, AI App Security and eval harness.
- **2026-08-18 to 08-20:** Sprint 10 billing/usage, Local/Desktop/licenses/sync, affiliates/payout ledger, plugin v0.1.17, operations runbooks.
- **2026-08-21:** backup/restore proof, worker egress proxy, Upstash TLS BullMQ cutover, public `6379` removal, restart-safe DNS refresh, immutable worker promotion, current Standard/Luna production acceptance, and AI App Security coverage/evidence remediation.

PR history remains in Git and GitHub. Use `git log`, PRs, migrations, and executable tests for forensic detail; this guide retains only current architecture and durable decisions.
