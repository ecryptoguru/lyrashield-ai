# LyraShield AI — Codebase Guide

> Current implementation map: 2026-09-02 (post Deep Review v14 and the WP1–WP7 launch-assurance wave). Read [AGENTS.md](./AGENTS.md) first for the immediate handoff and rules; use [PRD.md](./PRD.md) for product scope and release gates. Running code, Prisma schema, migrations, CI, and live evidence override this guide.

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
| `apps/marketing`        | Astro/Cloudflare marketing, blog, public tools, product-updates/referrals, Lite Scanner frontend                          |
| `apps/marketing-motion` | Deterministic Three.js marketing media production                                                                         |

### Shared packages

| Package            | Responsibility                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `auth`             | Better Auth server/client split, sessions, permissions, OAuth workspace binding            |
| `db`               | Prisma schema/migrations/client, RLS/scoping, audit chain, domain services                 |
| `types`            | Zod schemas, DTOs, enums, queue/action/scan contracts, OpenAPI exports                     |
| `ui`               | Accessible shared controls, cards, forms, dialogs, themes, loading/empty states            |
| `config`           | Environment schemas and shared TypeScript/ESLint configuration                             |
| `logger`           | Structured, circular-safe, truncating, secret/PII-redacting logs                           |
| `integrations`     | GitHub, Redis, shared queue, notifications, external providers                             |
| `security`         | SSRF-safe fetch, public-surface analysis, AI security scanner, prompt/input controls       |
| `egress-proxy`     | Authenticated DNS-pinned SSRF-safe URL fetching                                            |
| `score`            | Pure versioned LyraShield Score calculation and eligibility rules                          |
| `billing`          | Polar/Razorpay gateways, entitlements, trial, usage, packs, grace, overage, sync           |
| `pricing`          | Cloud plans, minute packs, Local SKUs                                                      |
| `licenses`         | ed25519 license signing/verification and canonical JSON                                    |
| `affiliate`        | Attribution, commissions, fraud checks, payouts, reserves, webhook dispatch                |
| `evidence-storage` | AES-256-GCM envelope encryption and private storage abstraction                            |
| `mcp`              | API-backed MCP server, stdio transport, tool schemas, prompt-injection guard               |
| `sdk`              | Authenticated API client used by CLI and MCP                                               |
| `credentials`      | Single source for `~/.lyrashield/credentials.json`, env precedence, API URL normalization  |
| `cli`              | Canonical unscoped `lyrashield` CLI                                                        |
| `cli-alias`        | Deprecated `@lyrashield/cli` compatibility wrapper                                         |
| `agent-registry`   | Install metadata for supported coding agents                                               |
| `agent-rules`      | Agent policy/rule/skill rendering                                                          |
| `agent-plugin`     | Portable plugin, MCP descriptor, skill, and client shims                                   |
| `gate`             | Pure versioned Launch Gate standard (`lyrashield-gate/1.0.0`) and verdict computation      |
| `fix`              | Fix-PR core: plan-tiered diff scope policy, fail-closed diff validator, applier, checksums |

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
Before execution, the worker binds every authority-bearing BullMQ field (`workspaceId`,
`targetId`, `goal`, `mode`, and `policyId`) back to the stored scan; schema-valid queue
data cannot upgrade routing, budget, or policy.
The scans list revalidates its first page with an ETag. If pagination hides a loaded active
scan, one workspace-scoped query refreshes only those IDs, bounded by the three-scan
workspace concurrency limit, so terminal transitions do not become stale polling loops.

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
- `WORKSPACE_SCOPED_MODELS` contains only directly scopable models with `workspaceId` (31 models; `GateVerdict` joined with its RLS migration `20260902100000_gateverdict_rls`).
- Child tables are scoped through parents and protected by fail-closed RLS policies. `GateVerdict` is RLS-protected directly (batch-3 permissive/strict pattern).
- Production runtime role must be neither superuser nor `BYPASSRLS`.

### Audit chain

Use `prisma.auditLog.create()` through the extended client. Its advisory-locked transaction owns `prevHash`/`hash` serialization. Do not place audit creation inside a broader transaction. Any mutation of hashed audit fields requires a locked chain rebuild.

### Queue and lifecycle

- Queue authority: `packages/integrations/src/queue.ts`.
- Use `getScanQueue()` and `enqueueScan()`; never instantiate one-off queues. The fix-generation queue is `enqueueFixGenerate()` from the same module (jobId = fixProposalId); its worker consumer skips proposals already `ready`.
- Admission checks worker readiness before Scan creation and again at enqueue.
- Worker heartbeat refreshes every two minutes and expires after five minutes. Heartbeat registration and readiness each use a single-key Lua operation; the separate admission-stop key is checked with `EXISTS` so Redis Cluster never receives a cross-slot script.
- BullMQ workers use a 10-minute idle `drainDelay` and one-minute stalled check. The modeled 30-day idle command count is 324,019 before and 132,495 after this pacing change (59.11% reduction); it is not live telemetry.
- Reconciliation runs unconditionally at startup. Its five-minute timer reconciles when the DB has nonterminal scans, backs off to an hourly Redis inspection when idle, and reconciles fail-safe when the DB preflight is uncertain. Queue/database orphans fail after five minutes and are never auto-replayed.
- Status changes go through guarded transitions, not direct updates.
- Worker cancellation terminates registered engine processes and preserves auditable state.

Lifecycle:

```text
QUEUED → PREFLIGHT → RUNNING → VERIFYING → COMPLETED
```

Alternatives: `FAILED`, `PARTIAL` (engine stopped with findings preserved), `CANCELLED`, `TIMED_OUT`, `STOPPED_BUDGET`, `REQUIRES_APPROVAL`. After any terminal state the worker refreshes the target's gate verdict (`evaluateGateForTarget`, best-effort). A failed engine run persists a bounded, redacted stdout/stderr tail to encrypted evidence storage (`engine-stream-tail`) referenced from an `engine_exit_tail` scan event — raw stream content never enters operational logs.

### Engine boundary

- Product code lives in engine `lyrashield/**` and `lyrashield_adapter/**`; upstream `strix/**` retains only hard-gated generic seams.
- Stable upstream releases enter through reviewed PRs; never force-push or auto-resolve conflicts.
- Worker builds engine from sibling repo using named Docker context.
- Worker and engine child share the same resolved, host-visible `TMPDIR`; engine
  checkout paths are derived from it so host Docker can bind-mount the cloned source.
  Local Compose uses a protected project-owned path (or explicit
  `LYRASHIELD_WORKER_TEMP_ROOT`) and performs no privileged recursive ownership mutation.
- `lyrashield --version`, immutable app/engine OCI labels, and digest reconciliation are image gates.
- CLI exit `0` means completed/no findings; `2` means completed/findings; other nonzero means runtime/config failure.
- Output artifact reads and parsed fields are bounded. Raw stdout/stderr and raw engine
  output are neither logged nor persisted; only the fixed engine-owned failure class may
  enter operational logs.

### Model routing and accounting

Authorities:

- `apps/worker/src/engine/runner.ts`: `resolveEngineProfile()`.
- `apps/worker/src/engine/command-builder.ts`: `resolveScanBudgetUsd()`.
- `apps/worker/src/engine/gpt56-pricing.ts`: versioned rate card.

Safe/Quick/Standard use Luna/medium. Deep/Custom use Terra/medium root plus Luna/high specialists. The fallback model remains mandatory and policy values may only lower caps. Private receipts preserve actual model, requests, token buckets, cache reads/writes, long-context usage, provider cost, billed cost, and reconciliation status.

Agent-minute wall time starts immediately before `runEngine()`. A repository run is
metered only after a scan-bound completed receipt or scan-bound affirmative provider usage proves
model-backed work occurred. Deterministic URL/API runs and pre-provider failures do not
consume agent-minutes; failed runs with positive provider usage remain billable.

### Findings and result integrity

- `confidence` never sets `verified`.
- Engine and scanner output create bounded candidates and receipts.
- Evidence must use `uploadEvidence()` with checksum and encryption key reference.
- New claims are `DETECTED` unless trusted evidence establishes another state.
- Deterministic clean retest can produce `VALIDATED` only with complete originating coverage.
- Engine-only retest absence remains `INCONCLUSIVE`.
- Direct `FIXED` becomes `FIXED_PENDING_RETEST` until server-owned retest evidence exists.
- Retest validation binds to stored immutable evidence: the finding's original source scan and the retest scan must both have stored result manifests, exact repository revisions (which may differ after a fix) or matching URL checksums, and complete deterministic family coverage. Missing or malformed identity writes an idempotent `INCONCLUSIVE` receipt and never sets `FIXED`.
- The result manifest is persisted before retest finalization; crash recovery resumes pending retests from stored receipt evidence before scoring, without replaying billable work.
- Findings list responses carry a deterministic page-local priority heuristic (severity, status, verified, confidence, target environment, business impact/exploitability context). It is triage context, never proof of exploitability or reachability, and does not change cursor pagination.
- Finding detail never exposes raw evidence storage URIs; retest receipts surface baseline/retest scan IDs, manifest checksums, revisions, method, and coverage state.
- Repository findings carry `baseCommit` (the scanned source revision, stamped by `persistFindings`), `implicatedFiles`, and structured fix evidence. The fix-PR pipeline: proposal → `fix-generate` job (deterministic diff from the engine's structured fix, plan-tiered scope validation: PRO+ implicated-set/200 lines, STARTER and below current-file/100) → approval-bound execution (`fix-pr.ts`, checksum-bound, re-validated at execute time, no merge call anywhere). A merged `lyrashield/fix-` branch closes the loop: PR marked merged, a NEW retest scan created and enqueued (the Retest binds to the NEW scan id), gate verdict re-evaluated. Loop-closure failures delete the webhook delivery marker so GitHub redelivers the idempotent path.
- The Launch Gate: `packages/gate` computes the verdict (`lyrashield-gate/1.0.0`, pure, versioned); `packages/db/src/gate-service.ts` persists append-only `GateVerdict` rows under RLS; uncovered target types always yield INSUFFICIENT_EVIDENCE. `packages/db/src/launch-report-payload.ts` is the ONLY public launch-report payload constructor (key-set regression test, same discipline as `buildScorecardPayload`).
- Result manifests bind worker execution provenance into their checksum: exact product revision, worker image digest, and engine revision. The production worker fails closed before readiness when any value is missing or malformed; the VM launcher derives all three from the digest-pinned image and its OCI labels.
- `provision-alerts.sh` reads every rule back after provisioning and fails unless each metric alert and scheduled query is enabled, auto-mitigates, and is bound to the operator action group. `scan_worker_lease_expired` remains unprovisioned until a durable counter exists.
- `verify:launch-assurance` (host-side, dry-run first) composes evidence proofs, readiness, Azure alert readback, authenticated cancellation, and `reconcileScanQueue` into one ordered command with a bounded JSON receipt. Dry run is read-only; full mode requires exact scan/workspace IDs and the production confirmation phrase.

### GitHub and approvals

- Callback state alone cannot claim an installation.
- Installation ownership must be provider-backed and bound to initiating user/workspace.
- Approval claims exact action name and input hash atomically and once.
- Fix PR route accepts no client-authored patch, branch, title, or body.
- PR execution is fail-closed: privileged PR creation runs only a server-generated immutable patch/evidence artifact, immutably bound to an explicit human approval.

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

Exact health/readiness requests use a local 120/minute bound and do not call the
Upstash REST limiter. A failed Upstash initialization or request opens a 60-second process-local cooldown;
ordinary endpoints remain bounded by their existing in-memory fallback and the next
request after cooldown probes shared limiting once.

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

Current package/runtime contract: `lyrashield` CLI `0.2.0` supports Node 22–24; `@lyrashield/mcp` `0.2.4` and `@lyrashield/agent-plugin` `0.1.18` require Node 24+. MCP uses SDK `1.30` and Zod 4. Registry contains 30 entries and resolves 26 preferred client surfaces: 13 config-file installs, one vendor CLI, seven guided-manual clients, and five Agent Plugin installs for Claude Code, Cursor, OpenAI Codex, GitHub Copilot, and Kiro. Registry retains three legacy config-file alternatives for plugin-preferred clients. Four generated client-specific shims cover Claude Code, Cursor, OpenAI Codex, and Kiro; GitHub Copilot uses the portable root plugin manifest. VS Code stays on its verified config-file path.

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
- workspaces, onboarding, team, and reviewed account-deletion requests;
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
- Database: `DATABASE_URL`, `DATABASE_DIRECT_URL`, and a separately scoped `DATABASE_SYSTEM_URL` where a verified cross-workspace path requires it. Production app and worker each receive separately provisioned, bounded system credentials for reviewed global operations; Lite Scanner receives none. Billing staging uses `app_system_staging` only for license operations, while ordinary traffic uses RLS-bound `app_runtime_staging`.
- Queue: `REDIS_URL`; production BullMQ requires authenticated `rediss://`.
- Rate limit: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` only.
- Engine: `LYRASHIELD_LUNA_LLM`, `LYRASHIELD_TERRA_LLM`, `LYRASHIELD_LLM`, Azure API values.
- Evidence: `S3_*` plus encryption/key references.
- Proxy: `LYRASHIELD_EGRESS_PROXY_URL`, `LYRASHIELD_EGRESS_PROXY_SECRET`.
- Email: `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION`, `BREVO_API_KEY`, sender values.
- Billing: Polar/Razorpay credentials, price maps, webhook secrets; isolated billing staging additionally requires `LYRASHIELD_DEPLOYMENT_ENVIRONMENT=billing-staging`, `BILLING_STAGING_ADMISSION=restricted`, and the protected access-session secret while every normal purchase admission remains `off`.
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
- The dashboard is one adaptive surface: `lib/dashboard-overview.ts` is the typed server-side read model (scores bound to scans via `ScoreSnapshot.scanId`, per-target coverage from terminal-run receipts, workspace verdict gated on target coverage), and `lib/home-next-action.ts` derives the single next action. Progressive disclosure carries technical depth; presentation never changes authorization, data scope, or scan behavior.
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
- S3/R2-compatible evidence layer; the 2026-08-26 production round-trip and missing-KEK fail-closed probes passed.

### Current worker proof

(Record from the 2026-08-26 acceptance round. The engine worker pin has since advanced — engine `.lyrashield-worker-pin` now points at web `ae205163`, and web `deploy-azure.yml` pins engine `2c8fccc3e37a5e21f5752503cc77fc752519cdce` — but no new acceptance round has run against the post-v14 deployment; the evidence below describes the 2026-08-26 deployment.)

- Product revision: `16a1fb7014ce3cbf9e56b69bff5074a5d0d8e0dd`.
- Engine revision: `852b1ed7ff76d177cef4db5aa1cfbd3bbe6d2664`.
- Worker digest: `sha256:cb0f836eb54825517e900468a87c6d09b5e9df636121b49d8683b1766849fceb`.
- Sandbox digest: `sha256:73067cefe2138c89c1f63abb597f006f66eae22dca332a6b01398d870a638dcf`.
- Container Apps: app `lyrashield-app--0000195`, scanner `lyrashield-scanner--0000176`, and egress proxy `lyrashield-egress-proxy--0000045` at 100% traffic; CI `32966602739`, release `32967467190`, candidate/public smoke, and post-recovery readiness passed.
- BullMQ Redis: TLS/authenticated `PONG`, live heartbeat, empty queue before acceptance.
- Azure public `6379`: removed.
- Legacy Redis: stopped, restart-disabled, rollback-only.
- Egress: direct public denied, proxy public allowed, loopback denied `ssrf_blocked`.
- DNS refresh timer: an OSV pin change exercised the planned-drain path during the current Standard scan. The scan completed without interruption or replay; the next timer restarted the exact worker digest and readiness recovered. The temporary `503` was a real new-admission outage and remains alertable.
- Redis/egress efficiency code is deployed. Live command metrics and longer-window capacity evidence remain required.
- Backup/restore: encrypted backup, isolated restore, schema/RLS/audit/app startup verified.
- Production evidence storage passed encrypted round-trip, checksum, isolation, tamper-denial, cleanup, and missing-KEK fail-closed probes. Managed-identity license signing passed Key Vault retrieval, denied-identity, in-memory sign/verify, Desktop fingerprint parity, and missing-secret tests; this does not claim non-exportable remote signing.
- Both administrators acknowledged the Azure test notification. The controlled orphan drill failed synthetic scan `cmta574d50004fef1nbydufai` as `QUEUE_ORPHANED` without execution or replay, then restored the exact worker and reconciled both queues to zero.
- Exact-two preflight `32925726620` and apply `32925979621` passed. Both operators then completed independent Google-plus-TOTP browser proof across every bounded admin destination; unauthenticated, bearer-only, and workspace-header-only requests remained denied.
- Production includes PR #426 billing-staging hardening, PR #432 Redis/egress efficiency, and PR #450 secure scan-owned checkout recovery. Purchase admissions remain `off`. Provider catalog/webhook readiness was observed separately on 2026-08-26; deployment still does not prove hosted checkout or entitlement/usage events.
- Billing staging is a distinct code-only deployment surface: `.github/workflows/deploy-billing-staging.yml` builds `runner` and `workspace-builder` from the dispatched main SHA into the isolated ACR, deploys only immutable digests, invokes image-owned migration/role scripts as exact Container Apps Job commands, and cleans up the jobs. The web proxy gates ordinary staging routes with an opaque HttpOnly same-origin access session while leaving exact health/readiness and signature-validating billing webhook ingress reachable. `BILLING_STAGING_ADMISSION=restricted` requires staging marker/origin plus Sandbox/Test modes and all production admissions off; no execution or live billing proof is implied.

### Current Standard scan proof

- Scan `cmt9el7p7000001hdjnjo90wk`.
- `OnboardingAI2` revision `1689f3607d68764e09769535df8e368c4d5ad2fe`.
- Completed in 10m 9s.
- 189 Luna/medium requests; no Terra.
- 8,549,456 input, 6,535,778 cached input, 136,759 cache-write input, and 32,092 output tokens; no long-context bucket.
- Raw provider cost `$0.57879951`; stored provider and billed cost `$0.578800` under the `$3.20` cap; per-request model buckets matched the engine total.
- 25 retained findings, zero independently verified. Seventeen remain `DETECTED`; eight remain `INCONCLUSIVE`.
- Manifest v5 checksum `ebfa3fb0ba19d97d8d9393432f8dbe37078b4bcf0367a7b91c21fe54a78e5687` binds the exact source revision and product/worker/engine/sandbox identities; `sourceCheckoutAvailable=true` and sandbox cleanup completed.
- Engine, SCA, secrets, agent configuration, ML supply chain, and AI App Security family receipts completed; URL was not applicable. AI App Security scanned 217/217 eligible files and 1,956,360 bytes with zero skips or reached limits.
- 10 agent-minutes debited from 596,659 ms engine wall time at the Standard 1× multiplier.

This is target/revision-scoped runtime and accounting proof, not a security guarantee.

### AI App Security coverage remediation

- `ai-app-security.ts` ranks production/config sources ahead of tests and fixtures, excludes generated artifacts, and applies explicit mode caps: Quick/Safe 200, Standard 500, Deep/Custom 1,000.
- Discovery produces structured eligible/scanned/skipped/byte counts, skip reasons, limit codes, and a bounded representative skipped-path sample.
- `scanner-orchestrator.ts` merges discovery limits into AI scoring and provenance. `result-integrity.ts` persists the `ai_app_security` family receipt in manifest v5 and later, preventing bounded AI coverage from becoming a complete clean claim. Current manifest v6 also binds the intended terminal outcome so crash recovery preserves partial, failed, budget-stopped, and timed-out results; historical v5 manifests remain readable.
- The scan-detail UI shows coverage counts and skipped-path samples instead of only the legacy one-line warning.
- Regression coverage uses an exact 217-file repository: Quick scans 200 and reports 17 skipped while retaining vulnerable production code; Standard scans all 217. Generated directories are excluded.
- PR #386's coverage remediation and PR #450's secure source-checkout recovery are deployed. Scan `cmt9el7p7000001hdjnjo90wk` runtime-proved complete 217-file Standard discovery and immutable source identity for one target/revision. Historical scan `cmt35aj1s000001hck9fmguzk` remains bounded and unchanged.

## 12. Key files

| File                                                    | Purpose                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/web/src/proxy.ts`                                 | CSP, rate limit, trusted client IP                           |
| `apps/web/src/lib/api-client.ts`                        | Typed client requests                                        |
| `apps/web/src/lib/api-response.ts`                      | Typed server responses                                       |
| `apps/web/src/app/api/scans/route.ts`                   | Scan admission and creation                                  |
| `apps/web/src/app/billing/webhook/route.ts`             | Polar/Razorpay idempotent webhook boundary                   |
| `apps/web/src/lib/licenses/license-service.ts`          | Production signing boundary                                  |
| `apps/worker/src/jobs/run-scan.job.ts`                  | End-to-end scan orchestration                                |
| `apps/worker/src/engine/runner.ts`                      | Bounded/cancellable engine subprocess                        |
| `apps/worker/src/engine/command-builder.ts`             | Engine arguments and budget policy                           |
| `apps/worker/src/engine/gpt56-pricing.ts`               | Versioned GPT-5.6 rate card                                  |
| `apps/worker/src/engine/scanner-orchestrator.ts`        | Deterministic and engine result merge                        |
| `apps/worker/src/engine/result-integrity.ts`            | Manifest/candidate/receipt boundary                          |
| `apps/worker/src/operations/verify-launch-assurance.ts` | Host-side dry-run-first launch-assurance orchestrator        |
| `ops/monitoring/provision-alerts.sh`                    | Actionable Azure alert provisioning with readback            |
| `ops/worker/run-worker.sh`                              | Worker VM launcher with provenance derivation                |
| `packages/integrations/src/queue.ts`                    | Shared queue authority                                       |
| `packages/db/prisma/schema.prisma`                      | Executable data model                                        |
| `packages/db/src/scoping.ts`                            | AsyncLocalStorage and scope policy                           |
| `packages/db/src/rls.ts`                                | Transaction-local RLS context                                |
| `packages/db/src/scan-transitions.ts`                   | Lifecycle guards                                             |
| `packages/db/src/score-service.ts`                      | Score persistence/public payload boundary                    |
| `packages/security/src/safe-fetch.ts`                   | Redirect-safe pinned fetch                                   |
| `packages/mcp/src/prompt-injection-guard.ts`            | Model-input guard                                            |
| `ops/worker/*`                                          | Worker VM services, secrets, egress, promotion, verification |
| `.github/workflows/ci.yml`                              | Main release gate                                            |
| `.github/workflows/deploy-azure.yml`                    | Migration-first Azure deployment                             |

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
- **2026-08-24 to 08-25:** current assurance hardening (PRs #428–#430): nonnegative policy budget constraint, explainable finding priority, immutable retest validation bound to stored manifests, raw evidence-storage URI removal, worker execution provenance in manifest v5 with production fail-closed readiness, actionable Azure alert provisioning with readback, and a bounded host-side dry-run-first launch-assurance orchestrator.
- **2026-08-26:** exact-two administrator provisioning/browser proof, evidence-storage and Key Vault signing proofs, operator alert acknowledgment, terminal-cost disposition, controlled queue-orphan recovery, current exact-SHA deployment, and temporary public-scorecard verification/revocation. The scorecard pass found and fixed a shared-image canonical-origin regression; deployment readback remains pending.

PR history remains in Git and GitHub. Use `git log`, PRs, migrations, and executable tests for forensic detail; this guide retains only current architecture and durable decisions.
