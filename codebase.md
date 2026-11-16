# LyraShield AI — Codebase Guide

> Current implementation map: 2026-09-25 (post Deep Review v20 and the connectors, Myra and GPT-6 routing waves). Read [AGENTS.md](./AGENTS.md) first for the immediate handoff and rules; use [PRD.md](./PRD.md) for product scope and release gates. Running code, Prisma schema, migrations, CI, and live evidence override this guide.

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
| `gate`             | Pure versioned Launch Gate standard (`lyrashield-gate/2.4.0`) and verdict computation      |
| `fix`              | Fix-PR core: plan-tiered diff scope policy, fail-closed diff validator, applier, checksums |

Generated output—`.next`, `dist`, `.turbo`, `.astro`, `.wrangler`, motion renders, media-local, Prisma generated client, `node_modules`, and `*.tsbuildinfo`—is not source.

The former `packages/eval-ai-safety` runner was removed as unused in `b96e597`. Its recorded 2026-08-13 result artifact was deleted from `apps/marketing/src/data/ai-safety-results.json` in the landing-page redesign (Wave 0 item 0.2), and `apps/marketing/src/pages/ai-safety.astro` no longer renders any figure from it: the page is now "MCP guard evaluation" and describes only the guard's pattern categories and its limits. Rerunning that historical benchmark requires restoring or replacing the runner. The separate fixed, non-destructive live AI safety catalog is tracked in `packages/types/src/ai-safety-tests.ts` and documented in `docs/yellowpaper.md` §3.5.

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

Protected routes use `{ success: true, data }` or `{ success: false, error: { code, message, requestId } }` and carry an `x-request-id` response header. Lists use cursor pagination. Client code reuses `apiGet`, `apiPost`, `apiPatch`, `apiDelete`, and `apiGetPaginated` rather than ad hoc fetch wrappers.

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

Repository scans invoke the controlled engine. URL/API launch supports deterministic Safe/Quick only; the engine-backed Standard/Deep/Custom profiles are removed from the launch offering (see `docs/Phase2.md`) and require a future explicit product decision. Historical engine-backed profile code remains a source contract, not an availability claim.
Before execution, the worker binds every authority-bearing BullMQ field (`workspaceId`,
`targetId`, `goal`, `mode`, and `policyId`) back to the stored scan; schema-valid queue
data cannot upgrade routing, budget, or policy.
The scans list revalidates its first page with an ETag. If pagination hides a loaded active
scan, one workspace-scoped query refreshes only those IDs, bounded by the three-scan
workspace concurrency limit, so terminal transitions do not become stale polling loops.

The v26 dependency capability registry is `packages/types/src/dependency-capabilities.ts`. `resolved-dependencies.ts` dispatches supported Cargo/Ruby/Go inputs through `additional-dependencies.ts`; unsupported/malformed/bounded discovered inputs keep the receipt incomplete. `ecosystem-lock-parsers.ts` retains exact source/platform/checksum identities and strict Cargo SemVer/source edges. `go-module-resolver.ts` runs pinned native Go metadata-only in a nonroot, network-none container; `go-metadata-broker.ts` mediates fixed-host metadata with bounded provenance receipts. No build/test/generate/source/VCS/toolchain download is allowed. Public-network and amd64 qualification remain separate. Scanner work budgets and cooperative yields bound hostile PHP/IaC/OpenAPI traversal; missing inputs never become clean coverage. OSV retains ≤100-package batches, two active streamed requests, a shared 15s deadline, bounded retries and complete-only cache writes, with case-sensitive Go/Ruby identity normalization.

### URL/API scan

- Target creation performs SSRF validation.
- Fetch time resolves, validates, pins, and revalidates each redirect.
- Production URL fetching uses authenticated `packages/egress-proxy`.
- Profiles bound documents, depth, bytes, concurrency, methods, origin probes, and wall time.
- API Standard/Deep (source contract only; removed from the launch offering) require validated public HTTPS OpenAPI input.
- Engine-backed tiers require current domain verification, sponsor entitlement, and a signed grant bound to the scan, workspace, target, host, methods, and request budgets.
- The remote relay supports explicit absolute-form HTTP/HTTPS requests and rejects opaque CONNECT tunnels. The engine sandbox-local TLS adapter uses the installed sandbox CA to convert ordinary HTTPS client traffic into inspectable relay requests. Composed local curl and Chromium navigation/fetch tests passed allowed requests and denied path/method/redirect requests without TLS bypass; invalid upstream certificates were rejected. This verifies bounded local transport, while exact-image production deployment and a paid URL engine scan remain unverified.

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

Workspace API keys are available to non-browser clients. Owners and Admins manage them with a browser session under Settings → API keys and `/api/api-keys`; create returns the raw key once, while storage retains only its SHA-256 hash and display prefix. Keys are workspace-bound, tied to their creator, carry coarse read/write scopes, support optional expiry, and are limited to 20 active keys per workspace. Verification rejects revoked, expired, deleted keys and keys whose creator is no longer an active workspace member; each REST action still enforces the creator's current permission. Direct REST and local stdio can use these credentials within those checks. Hosted remote MCP writes require a delegated OAuth connection.

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

`UserScanSlot` is initiating-user-owned through `app.current_scan_user_id`; `ScanCapacityReservation` is sponsor-account-owned through `app.current_account_id`. `scan-slot.ts` owns the user advisory lock and safe release. Keep initiating-user lock before workspace/target/account admission and keep account context distinct from the initiating user's slot context. `scan-capacity.ts` receives the caller's transaction; it does not create a second transaction. New tables use forced RLS and need explicit runtime grants at rollout.

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
- `createScan` atomically creates the immutable execution plan, version-2 user slot, capacity reservation and queued event. `Scan.accountingSettledAt` distinguishes execution/accounting finalization from terminal status. `capacity-lifecycle.ts` owns preparation, wait/defer and final safe release; unknown executor or settlement outcome retains the hold.
- `schedule-service.ts` uses exact version/occurrence CAS in that same admission transaction, including lastScanId. Shared URL admission lives in `packages/types/src/url-review-admission.ts` with integrations/web wrappers. Transient deferrals preserve one pending occurrence; permanent denials advance with bounded reasons. Due reads use 50-row stable ID keysets and an inter-operation 15s poll budget. `ScanEnqueueNotSubmittedError` proves only this invocation did not call add and restores only its freshly created exact identity; uncertain acknowledgements preserve the original scan/job.
- Worker cancellation terminates registered engine processes and preserves auditable state.

Lifecycle:

```text
QUEUED → PREFLIGHT → RUNNING → VERIFYING → COMPLETED
```

Alternatives: `FAILED`, `PARTIAL` (engine stopped with findings preserved), `CANCELLED`, `TIMED_OUT`, `STOPPED_BUDGET`, `REQUIRES_APPROVAL`. Every truncated engine stop — runtime deadline, content-filter stop or engine stop — records a bounded coverage receipt with the outcome so a cut-short engine scope is never presented as a complete pass; deterministic scanners still run afterward. After any terminal state the worker refreshes the target's gate verdict (`evaluateGateForTarget`, best-effort). A failed engine run persists a bounded, redacted stdout/stderr tail to encrypted evidence storage (`engine-stream-tail`) referenced from an `engine_exit_tail` scan event — raw stream content never enters operational logs.

### Engine boundary

Candidate Cloud, recovery and Desktop release workflows pin merged engine `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c`, including engine PR #225 trusted normalization descriptors, #226 frozen evaluation-v3 corpus/scorer, #227–#232 diagnostics and CI safeguards, #233–#234 independent inventory verification, #235 scan-bound gateway identity, #236 nested Python inventory coverage, #237 signed attach-only controller sandbox execution, #238 OpenTelemetry 1.45.2/0.66b2 for CVE-2026-126360 with the reverse worker-consumer pin, [#240](https://github.com/ecryptoguru/lyrashield-engine/pull/240) canonical SDK manifest production and consumption for signed controller attachment, and [#242](https://github.com/ecryptoguru/lyrashield-engine/pull/242) sandbox-startup cleanup ownership and native-boundary CI routing. This revision retains the established model, relay, bounded-runtime, acquisition and immutable-evidence contracts. Evaluation profiles remain unmeasured and public benchmark claims disabled. The current deployed engine is `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c` (release 43764099383). Production promotion on the normal release path no longer depends on the retired runtime-fleet qualification record (2026-11-15; it had no issuer and blocked every deployment). Repository-scan isolation remains: pinned sandbox image, the egress-restricted `lyrashield-sandbox` network and the deny-by-default firewall; provenance, budget and evidence checks are unchanged. Worker startup selects the established production baseline (`existing-production-baseline`) when no broker installation exists; an existing-but-unverifiable installation fails closed with a warning. Retained-worker and high-availability lanes remain held. Product protection requires `Pinned Engine / Worker Contract` alongside security and lint/typecheck/test/build. Engine CI separately tests its exact `.lyrashield-worker-pin` consumer; update that reverse pin only after final merged-product compatibility verification. Source compatibility, production qualification and signed Desktop publication remain separate gates. Desktop launch remains deferred.

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

- `packages/security/src/engine-profile.ts`: `resolveEngineProfile()` (re-exported by the worker).
- `apps/worker/src/engine/command-builder.ts`: `resolveScanBudgetUsd()`.
- `apps/worker/src/engine/gpt6-pricing.ts`: GPT-6 rate card.

Safe/Quick/Standard use GPT-6 Luna/medium. Deep/Custom use GPT-6 Sol/medium root plus Luna/high specialists. The fallback model remains mandatory and policy values may only lower caps. Private receipts preserve actual model, requests, token buckets, cache reads/writes, long-context usage, provider cost, billed cost and reconciliation status.

Agent-minute wall time starts immediately before `runEngine()`. An engine-backed run is
metered only after a scan-bound completed receipt or scan-bound affirmative provider usage proves
model-backed work occurred. Deterministic URL/API runs and pre-provider failures do not
consume agent-minutes. Failed scans are not billed, even when provider usage was observed.
Cancelled and partial scans may consume agent-minutes when scan-bound evidence establishes billable work.

Version-2 capacity authority is `packages/billing/src/usage/capacity.ts`; account funding waits are FIFO. `fundedRuntimeMs` floors whole multiplied capacity to wall time and subtracts `CAPACITY_STOP_MARGIN_MS=5000`. `meter.ts` records exact-cap partial usage and absorbed excess with immutable receipt identity; the funding projection distinguishes legacy gross consumption from version-2 allocated pool/pack/grace/overage. Legacy grant/consume reads use account/cycle/deletedAt-scoped SQL sums, without truncating totals. `confirmScanCapacityStopped` and slot helpers require actual stop/billing disposition before release. `REVIEW_REQUIRED` is conservative, not a timer-expiry permission to replay paid work.

### Standards evidence

`packages/security/src/standards` owns `standards-registry/1.1.0`; scan detail and report generation use the same renderer. Default entries pin OWASP Top 10 2021, API Top 10 2023, LLM Top 10 2025, CWE Top 25 2024, and selected ASVS 5.0.0 L1 requirements. Five unverified hidden mappings (ATLAS, CIS, AISVS, ISO 27001, and SLSA) are excluded until their identifiers, editions, and observable scope are reviewed. Family receipts provide bounded category evidence, not verification or certification. The renderer counts each finding once within a category and rejects explicit OWASP tags from a different edition. SAST completion credits its implemented crypto/TLS/JWT scope, not unrelated injection, memory-safety, or authorization categories.

### Findings and result integrity

`engine/repository-auth.ts` binds a private GitHub scan to the stored target and
active workspace integration before billable analysis. Its bounded, cancellable
preflight obtains a fresh single-repository `contents:read` token and rechecks the
same active integration after minting. Deterministic retest checkout uses the same
workspace authorization path. Checkout tokens are never cached. The exact clone-URL
credential scope passes only to the engine host through explicit child configuration;
the sandbox environment excludes it. Authorized GitHub API/write helpers retain their
installation grant; shared cache entries are encrypted and bound to app, installation,
and grant identity.

PHP detection reuses the existing `sca`, `iac`, `sast` and `url` families. Standard
and Deep repository integration first detects PHP project scopes and gates
PHP-specific analyzers and optional post-scan triage context on that result.
Monorepo service scopes stay distinct, and uncertain discovery or absent exact runtime identity stays
incomplete. Non-PHP repositories retain the ordinary scanner path without PHP
analysis or PHP triage context. The existing IaC walk records eligible PHP source
directories; `php-runtime.ts` reuses parsed declarations through
`discoverPhpRuntimeInput()` before invoking runtime analysis for applicable
inputs. `php-project.ts` owns documentation/test/fixture path exclusions shared
with PHP SAST; source extension matching is case-insensitive. No separate PHP
repository walk is added. `php-runtime-discovery.ts` builds a receipt from those
existing inputs, capped at 32 PHP scopes and 64 service boundaries. Child service
boundaries prevent inheriting a root runtime declaration or PHP context; overflow
stays incomplete and suppresses context. `php-engine-context.ts` enriches only
existing eligible medium-severity AI-security candidate excerpts in the enabled,
accounted Standard/Deep triage cohort within their 4,096-byte bound, with anonymous scope identifiers
and exact-identity completeness. Initial engine instructions and the number of
engine calls do not change; this is not full PHP engine acceptance.
`resolved-dependencies.ts` and `composer-dependencies.ts` resolve bounded exact
Packagist locks with manifest content-hash checks; `dependency-manifests.ts`
retains standalone discovery for other ecosystems. `php-runtime.ts` matches
declared/reported identities against the pinned shared
`packages/security/src/php-runtime-advisories.json` catalog through the worker
`php-runtime-catalog.ts` compatibility export. A banner creates only a passive lead. `php_runtime_` findings cannot
become `FIXED`/`VALIDATED` from source-only retests, even with complete source
manifests. The [PHP runbook](./docs/php-security.md) owns supporting inventory,
runtime replacement evidence and detection limitations. The free
`/tools/php2shell-checker` consumes the shared browser-safe
`@lyrashield/security/php-security` matcher for the original two advisories and
keeps the 23 October CVE-2026-115560 configuration review separate; neither path
performs a live probe or establishes deployed-runtime identity.

`packages/db/src/osv-details.ts` owns bounded full-advisory hydration shared by the
cached and standalone SCA paths. Incomplete detail retrieval or pagination cannot
produce complete coverage or a trusted cache snapshot; `osv-querybatch/3` excludes
legacy snapshots. `scanners/osv-cvss.ts` calculates complete CVSS 3.0/3.1 base
vectors while preserving the source vector; the shared schema retains advisory
CWE identifiers. Composer introduced-range boundaries may omit numeric minor or
patch components, while installed/fixed releases remain exact and stable.

Composer fixes use the existing job and encrypted artifact namespace through
`jobs/composer-fix-proposal.ts` and the digest-pinned offline producer in
`jobs/composer-fix.ts`. `packages/fix/src/composer-update.ts` binds exact identity,
before/after bytes, single-package semantics and resolver checks. Approval and
execution revalidate the receipt; ordinary patches still reject lockfiles.
Production metadata uses the authenticated egress proxy. Resolver consistency
does not prove application compatibility: summaries and approval inputs mark it
unverified and the provider PR is forced to draft for customer CI and review.
No new queue, schema or automatic merge path is added.
The producer preserves original unchanged-package/root metadata and JSON format
before its final validate/dry-run, keeping solver set/version changes visible to
the strict artifact validator. Scope rejections retain bounded user guidance.

- Deterministic repository retest authorization reads persisted lineage, parent-scoped manifests and coverage through one `withWorkspaceRLS` transaction. Failed proposal generation remains in history and does not block creating a fresh proposal.
- `confidence` never sets `verified`.
- Engine and scanner output create bounded candidates and receipts.
- Evidence must use `uploadEvidence()` with checksum and encryption key reference.
- Workspace integration credentials use workspace-bound encrypted artifacts; `Integration.configRef` stores the reference and safe list projections omit it. Account deletion enqueues eligible config artifacts through the existing `INTEGRATION_CONFIG` deletion-outbox kind in the same transaction as the metadata cascade; the worker removes external objects asynchronously with the existing lease/retry/dead-letter behavior. This cleanup path does not make account deletion self-service.
- New claims are `DETECTED` unless trusted evidence establishes another state.
- Deterministic clean retest can produce `VALIDATED` only with complete originating coverage.
- Engine-only retest absence remains `INCONCLUSIVE`.
- Direct `FIXED` becomes `FIXED_PENDING_RETEST` until server-owned retest evidence exists.
- Retest validation binds to stored immutable evidence: the finding's original source scan and the retest scan must both have stored result manifests, exact repository revisions (which may differ after a fix) or matching URL checksums, and complete deterministic family coverage. Missing or malformed identity writes an idempotent `INCONCLUSIVE` receipt and never sets `FIXED`.
- The result manifest is persisted before retest finalization; crash recovery resumes pending retests from stored receipt evidence before scoring, without replaying billable work.
- Findings list responses carry a deterministic page-local priority heuristic (severity, status, verified, confidence, target environment, business impact/exploitability context). It is triage context, never proof of exploitability or reachability, and does not change cursor pagination.
- Finding detail never exposes raw evidence storage URIs; retest receipts surface baseline/retest scan IDs, manifest checksums, revisions, method, and coverage state.
- Repository findings carry `baseCommit` (the scanned source revision, stamped by `persistFindings`), `implicatedFiles`, and structured fix evidence. The fix-PR pipeline: proposal → `fix-generate` job (deterministic diff from the engine's structured fix, plan-tiered scope validation: PRO+ implicated-set/200 lines, STARTER and below current-file/100) → approval-bound execution (`fix-pr.ts`, checksum-bound, re-validated at execute time, no merge call anywhere). A merged `lyrashield/fix-` branch closes the loop: PR marked merged, a NEW retest scan created and enqueued (the Retest binds to the NEW scan id), gate verdict re-evaluated. Loop-closure failures delete the webhook delivery marker so GitHub redelivers the idempotent path.
- The Launch Gate: `packages/gate` computes the verdict (`lyrashield-gate/2.4.0`, pure, versioned); `packages/db/src/gate-evaluation-service.ts` persists append-only `GateVerdict` rows under RLS; uncovered target types always yield INSUFFICIENT_EVIDENCE. `packages/db/src/launch-report-payload.ts` is the ONLY public launch-report payload constructor (key-set regression test, same discipline as `buildScorecardPayload`).
- Launch report issuance (`launch-report-service.ts`) selects one verdict and evaluates its applicability at issue time inside a RepeatableRead snapshot (policy fingerprint, newer-attempt, evidence drift, freshness), never trusting the stored staleness flag; `stale` maps every non-applicable/unknown outcome. The report row's private `provenanceJson` binds the exact `gateVerdictId`, verdict checksum, assessed release identity (commit/artifact digest), and issue-time applicability — written atomically with the signed payload, readable on authenticated surfaces (`GET /api/reports/[id]` `launchReport` block, reports list). A recipient holding the signed report and its live share capability may submit an expected identity to `POST /api/reports/verify`; the confirmation-only response is `MATCH`, `MISMATCH`, or `UNAVAILABLE` and never returns the stored value. Legacy reports without provenance display "Release identity unavailable for this report".
- Launch Readiness supports a target-scoped release check: `GET /api/launch-readiness?workspaceId=&targetId=&commit=|artifactDigest=` (full 40-hex SHA or `sha256:`+64-hex digest, mutually exclusive, repeated params rejected) runs the gate evaluation against the requested identity and returns `releaseCheck` with match/mismatch/cannot-confirm plus requested vs assessed identities. The dashboard form drives the same URL (`/dashboard/launch-readiness?targetId=&commit=`); without a reference the view stays informational.
- `GET /api/billing/local-availability` is the public, origin-checked-CORS, rate-limited, no-store read the marketing pricing page uses to disclose Local purchase availability for the visitor's resolved provider before any checkout link. It is display state only — `/buy/local` and `/api/billing/local-checkout` re-check admission authoritatively.
- Result manifests bind worker execution provenance into their checksum: exact product revision, worker image digest, and engine revision. New rows persist the exact JSON checksum input and hash those bytes. `verifyStoredManifestChecksum` verifies the SHA-256 value and structural agreement with JSONB, returning `MATCH`, `MISMATCH`, or `UNAVAILABLE`; a null legacy input stays `UNAVAILABLE` and is never backfilled. Duplicate persistence and pending finalization reject mismatches and never rewrite existing hashes. The production worker fails closed before readiness without execution provenance; the VM launcher derives it from the digest-pinned image and its OCI labels.
- `provision-alerts.sh` reads every rule back after provisioning and fails unless each metric alert and scheduled query is enabled, auto-mitigates, and is bound to the operator action group. `scan_worker_lease_expired` remains unprovisioned until a durable counter exists.
- `verify:launch-assurance` (host-side, dry-run first) composes evidence proofs, readiness, Azure alert readback, authenticated cancellation, and `reconcileScanQueue` into one ordered command with a bounded JSON receipt. Dry run is read-only; full mode requires exact scan/workspace IDs and the production confirmation phrase.

### GitHub and approvals

- Callback state alone cannot claim an installation.
- Installation ownership must be provider-backed and bound to initiating user/workspace.
- Approval claims exact action name and input hash atomically and once.
- Fix PR route accepts no client-authored patch, branch, title, or body.
- PR execution is fail-closed: privileged PR creation requires a content-addressed patch whose storage key binds the workspace, finding, proposal and decrypted-byte checksum to the server generator. Caller-supplied references may be recorded in drafts but cannot substitute for that binding, including in legacy proposals or pending approvals. The exact patch is bound to an authorization receipt: browser requests require human approval; API-key and delegated OAuth requests require verified credential permission and scope.

`fix-pr-execution-service.ts` persists the immutable-proposal execution key before remote mutation. `fix-pr.ts` prepares and writes files under that ownership and reconciles deterministic remote identity after uncertain local persistence/completion; losing callers cannot change the winning intent. `fix-pr-context.ts` validates producer-bound storage references before access. `fix-pr-merge-service.ts` takes the initiating-user then Fix PR advisory lock before `findFixPrMergeAnchor`, account binding, retest association and canonical scan creation in the same caller transaction. Exact scanned/default-head equality remains mandatory.

Repository acquisition and deterministic retest use fresh, uncached, repository-specific contents:read credentials through the separate checkout wrapper in integrations, with active-integration/repository validation. The remaining authorized installation-default token cache is encrypted and scoped by app identity, installation and grant; it is not repository scoped. Callback replay fixtures use real signed state with simulated provider exchange; they are not live GitHub acceptance.

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
- `apps/worker/src/operations/verify-checkout-readiness.ts`: read-only Cloud/Local admission, credential, and catalog preflight. It does not prove a live charge.
- `apps/web/src/lib/account-acquisition.ts` and `apps/web/src/lib/growth-metrics.ts`: first-touch account acquisition under account RLS and server-derived paid-account metrics; platform administrators are excluded from the paid aggregate.

Billing webhook inserts `WebhookEvent` before synchronous Track A/B/C processing. Money uses `Decimal(19,4)`, never Float. Usage, pack purchase, subscription, refund, commission, and payout operations are idempotent. Razorpay pack quotes bind the payer `accountId` into quote verification, and `payment_link.paid` rejects a conflicting `accountId` across link/payment note carriers — the verified quote, never unverified notes, chooses the credited account. A signed, identifiable delivery that fails catalog validation persists one bounded `WebhookEventRejection` row — provider, external id, identity source, event type and reason code, never payload or tenant data — before the 400 answer, so a billing dispute carries durable evidence of the rejection. `(provider, externalId)` dedupes rejected replays, a rejection never overlays an accepted `WebhookEvent`, and a persistence failure answers retriable 5xx rather than a falsely durable 400; invalid signatures and unidentifiable payloads produce no receipt. Agent-minute recording and FIFO pack debit share one workspace+account advisory-locked serializable transaction; each tick debits only its incremental spill beyond the monthly pool, and conditional pack updates prevent negative balances.

Subscriptions, entitlements, usage balances, allowances, grace, overage, and minute packs are **account-owned** (`BillingAccount.accountId`, `UsageRecord.accountId`, `MinutePack.accountId`); `workspaceId` fields on those rows are purchase attribution only. The sponsoring account is the persisted scan creator (`Scan.createdById` / `Schedule.createdById` / `ApiKey.createdById` / `AgentConnection.userId`); missing sponsor fails closed. `workspace.plan`/`deepAllowed` are display mirrors; entitlement decisions use the sponsor account's `effectivePlan`. Annual subscriptions receive monthly allowance cycles derived from the term anchor via the hourly `billing-allowance-replenishment` job. See `docs/yellowpaper.md` §5.3 for the ownership model and RLS boundary. Support evidence and history are indexed in [docs/README.md](./docs/README.md).

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

Cloud Sync connects through `/api/sync/connect`; the raw license key stays in the native OS keychain, and the 15-minute session token stays in Rust process memory. A direct-purchase license binds to one workspace on first connection under workspace RLS. `SyncCursor.seq` is the server-owned monotonic sequence: finding batches require `expectedSeq`, advance it by compare-and-swap, return `409 CURSOR_STALE` for conflicting batches, and allow exact idempotent replays. Findings remain unverified and `FIXED` becomes `FIXED_PENDING_RETEST`. Findings, bounded reports and cursor advancement commit atomically. Desktop stores its trusted cursor in native SQLite and adopts the server cursor after restart or rewind. Revocation is checked on each endpoint; disconnect clears native cursor state.

### Affiliate

- `packages/affiliate/src/attribution`: referral cookie/promo resolution.
- `packages/affiliate/src/commission`: Cloud/Local commissions and clawback.
- `packages/affiliate/src/fraud`: disposable email, velocity, device, self-referral.
- `packages/affiliate/src/payout`: eligibility, reservations, provider routing, reserve release.
- `apps/web/src/app/affiliates`: closed public application route, partner dashboard and admin surfaces.

The affiliate service owns commission and exclusion rules; new public application intake is paused while existing affiliate records and their recorded commission/refund handling remain intact. See [PRD affiliate terms](./PRD.md#affiliate-terms) for current commercial wording.

### Agent, MCP, CLI, and plugin

- Agent actions execute through existing API/service boundaries; there is no separate `apps/agent` runtime.
- `packages/mcp` owns tool definitions and transports.
- `packages/sdk` owns authenticated HTTP calls.
- `packages/credentials` owns stored credential semantics.
- `packages/cli` is canonical; `packages/cli-alias` is deprecated compatibility.
- `packages/agent-registry` owns client install metadata.
- `packages/agent-plugin` generates marketplace/plugin artifacts and verified client shims.

The coordinated release pins the `lyrashield` CLI to `0.2.14`, `@lyrashield/mcp` to `0.2.12`, and `@lyrashield/agent-plugin` to `0.1.31`; all require Node 24+. A version pin alone does not establish npm publication, marketplace listing, or authenticated client acceptance. MCP uses SDK `1.30` and Zod 4. The registry contains 51 install entries and resolves 48 preferred client surfaces, with client-specific install strategies and fallbacks. Cursor accepts a direct local plugin copy; Codex, Claude Code, and GitHub Copilot require their marketplace flows; Kiro Power import is primary on supported versions, with documented MCP activation as a fallback. The Codex installer registers the LyraShield marketplace before adding the plugin. OpenCode uses its documented global `~/.config/opencode/opencode.json` or project `opencode.json` location. VS Code stays on its MCP config-file path.

Hosted OAuth is read-only by default. A user can grant a connection a bounded set of workflows, targets, and scan profiles once during OAuth consent. Every delegated mutation then revalidates the connection, user membership, permission, scope, expiry, target, profile, and caller-supplied idempotency key. Scans created through a delegated connection record the grant (`delegatedConnectionId` + `delegatedAuthorizationVersion`), and the worker re-verifies that recorded grant at execution time: any grant mutation since admission — revocation, inactivity, expiry, a version bump, narrowed operations, or a target no longer covered — fails closed as `SCAN_AUTHORIZATION_REVOKED`. Report share/revoke and launch-report issuance under a delegated credential likewise enforce the grant's target scope from persisted evidence only (the report's linked scan target or the provenance-verified gate verdict — never the request body), and an unresolvable binding requires an all-targets grant. For hosted remote MCP, nondelegated writes—including API-key calls and requests carrying the retired `approvalId`—receive `connect_required`; the endpoint no longer offers the `PENDING`/`approvalId` round-trip. Direct REST and local stdio use the separate API-key scope and workspace-permission path.

### Marketing

- `apps/marketing/astro.config.mjs`: canonical origin and indexability contract.
- `apps/marketing/src/middleware.ts`: Worker response headers.
- `apps/marketing/src/pages/api/waitlist.ts`: D1 waitlist/referrals.
- `apps/marketing/src/pages/tools`: browser-local tools.
- `apps/marketing/wrangler.jsonc`: source bindings only.
- Deploy generated `apps/marketing/dist/server/wrangler.json`.
- `apps/marketing/src/pages/robots.txt.ts`, `llms.txt.ts`, `agents.md.ts`, sitemap configuration, canonical/schema helpers, comparison/research pages, and integration docs form the SEO/AEO/GEO surface. Production indexability gates crawler output; external indexing and citation still require separate receipts.

The latest user instruction defers D5 film-loading and all landing motion/layout changes. The five changed landing motion/runtime/layout files (`ScrollWorld.astro`, `scroll-world.ts`, `PremiumHero.astro`, `EvidenceWorld.astro`, `evidence-journey.ts`) are byte-identical to main `284523ca381ee0d6ffa62ce22e855f7ecae9518f`; existing motion browser tests are restored unchanged. Film scheduling, runtime mapping, chapter counters, styles, media and generation retain that baseline. One static light-theme text-color accessibility fix in `EvidenceMap.astro` remains; it changes no motion, scrolling or geometry. Independent header dismissal/mobile-menu and CLI copy fixes remain in the candidate. No new loading policy or production performance improvement is claimed.

## 7. API surface

The web app currently contains 170 route-handler files (164 under `app/api`). Grouped surfaces:

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
- Database: `DATABASE_URL`, `DATABASE_DIRECT_URL`, and a separately scoped `DATABASE_SYSTEM_URL` where a verified cross-workspace path requires it. Production app and worker each receive separately provisioned, bounded system credentials for reviewed global operations; Lite Scanner receives none.
- Queue: `REDIS_URL`; production BullMQ requires authenticated `rediss://`.
- Rate limit: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` only.
- Engine: `LYRASHIELD_LUNA_LLM`, `LYRASHIELD_SOL_LLM`, `LYRASHIELD_LLM`, Azure API values.
- Evidence: `S3_*` plus encryption/key references.
- Proxy: `LYRASHIELD_EGRESS_PROXY_URL`, `LYRASHIELD_EGRESS_PROXY_SECRET`.
- Email: `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION`, `BREVO_API_KEY`, sender values.
- Billing: Polar/Razorpay credentials, price maps, webhook secrets, and explicit Cloud/Local admission modes.
- License: Key Vault and signing key identifiers.
- Optional search: `LYRASHIELD_WEB_SEARCH_*`.

`lint/env-ownership.mjs` checks literal production reads against the central schema or exact external owners; it is unconditional in CI code quality. `NEXT_PUBLIC_SENTRY_RELEASE` and `OPENAI_APPS_DOMAIN_VERIFICATION_TOKEN` are declared. `TURNSTILE_ENFORCE_ACTION=0` is the trusted staged default for independent widget/app rollouts: hostname, freshness, success and replay remain checked, wrong nonempty actions fail, and only missing/empty legacy actions remain compatible. Mode 1 requires the exact action. The Go resolver pin and host preparation live in `run-worker.sh`; startup qualifies availability before queue consumption.

### Desktop environment

Public verification key and updater public key may ship. Private signing keys and LyraShield model keys may not.

### Marketing environment

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
- Onboarding explicitly chooses/creates a permission-eligible workspace in one server transaction. Repository selection is opt-in, paginated 50 at a time, with loaded-result search/reset and selected-form clearing. Approval and operation cursors remain independent; pending-page state is keyed by workspace/cursor while operation-only navigation preserves decisions. Scan capacity uses one stored-receipt `ScanCapacityBanner({scan})`, with elapsed time separate from charged minutes and conservative cancellation/finalization guidance. Error/empty/retention, missing-workspace and token-free password-reset recovery remain explicit.

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

Current command output is authoritative; never copy historical test counts forward as proof. `pnpm lint:env-ownership` checks configuration ownership. `pnpm lint:size` runs both TS and parser-aware Astro/MJS ratchets; baselines may only shrink. Presentation paths run their actual CSS/homepage source contracts; CI separately runs the real target-cap PostgreSQL fixture with named-case selection and restricted-role checks.

Local v26 reviewed source and original issue dispositions were recorded in the compact handoff (`docs/handoffs/v26-implementation-2026-10-30.md`, removed 2026-11-16; recover from Git at `c07b91203` or earlier). The final correctness-fix rereview and separate motion-preservation review passed; local browser proof is 310 cases including 80 axe scans with zero reported violations. Full core, later targeted reruns, static/operations/database checks and remaining build/image/remote/manual qualifications were source-qualified in that record; §11 production identities are not changed by local implementation. See [the cutover runbook](./docs/operations.md#v26-admissioncapacity-cutover-and-compatible-rollback) before any production action.

CI runs code quality, app/core/operations and selected marketing/motion work independently, then validates their results in the existing required aggregate. `.github/scripts/ci-selection.mjs` validates complete routing receipts, selects source consumers independently of image flags and combines selected quality dependency closures into one lint and one typecheck invocation; the app runner prepares SDK/MCP/plugin exports through the canonical plugin build closure before the full core suite. Optional PR image qualification covers packaging/build-environment inputs and copied worker host assets; ordinary source/test/style changes keep required host checks. Unknown inputs select all image targets. Release independently builds and verifies exact images before deployment, so an undeclared source packaging assumption may fail at release build before promotion. Knip remains manual reviewed maintenance (`pnpm lint:knip`, `pnpm lint:knip:baseline`), with no CI report step. Code quality has no dependency on runtime or image jobs and uses generated Prisma types without live services; marketing runtime separately generates its own schema exports. Static web presentation changes still compile and run the portable browser harness, while server/executable/unknown changes retain disposable-service proofs. `.github/scripts/qualify-release-source.mjs` binds successful required GitHub Actions checks and immutable PR base/head/merge evidence to the exact merged source tree before production routing. The latest genuine workflow attempt may still have optional jobs running or failed after all three required contexts succeed; queued, cancelled, malformed or unsupported outer states and incomplete required evidence fail closed. Both normal and squash merges require current main; unsupported or missing receipts fail closed. GitHub branch protection independently requires the three checks with strict base freshness and administrator enforcement.

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

### Readiness, release identity, and recovery

- `GET /api/ready/scans` returns `200` only when scan admission is not stopped and the worker heartbeat is available; Redis uncertainty fails closed as `503`. The stop key is separate from the worker lease, so the endpoint reports the combined admission condition rather than worker process health alone.
- Worker promotion is a controlled maintenance window. `.github/scripts/promote-worker-vm.sh` claims an owned admission stop, requires zero nonterminal scans and empty scan/webhook queues, checks the exact worker digest and OCI labels, restarts the worker, verifies health and execution provenance, then resumes only the stop it owns and probes scan readiness. If preflight or promotion fails, it restores the prior digest/host assets where changed and preserves another operator's stop. It does not force-drain active scans or auto-replay ambiguous work.
- A temporary `/api/ready/scans` `503` during that stop is a real period when new scans cannot be admitted, even when it is planned. Outside the matching controlled promotion, treat it as unexpected unavailability and follow the existing alert/readiness checks. DNS pin refresh is a different path: it applies the validated firewall union and in-place host update while preserving readiness and active work; failure retains the prior committed pins plus the union for retry.
- The release identity to compare is the product's exact 40-hex revision, the worker's immutable `sha256:` image digest, and the engine's exact 40-hex revision. The worker derives these from its digest-pinned image and OCI labels, validates them before readiness, and binds them into each result manifest. Source pins, green CI, or a deployment command alone do not prove the running identity; use the release readback and live readiness result for the same revision.
- App/scanner/egress promotion keeps the previous Container Apps revisions and restores traffic to them when candidate promotion or health smoke fails. Database migrations and app-scope configuration remain forward-only; image rollback never rolls back schema. Worker digest rollback is handled by the promotion script and its recorded prior digest, as described in [`ops/worker/README.md`](./ops/worker/README.md#promote-a-verified-worker-release).
- [`prepare-verified-backup-connection.mjs`](./.github/scripts/prepare-verified-backup-connection.mjs) validates one explicit supported TLS mode and applies the existing strict backup endpoint, principal, scope, compatibility and query checks. It strengthens legacy `require` to `verify-full` before `pg_dump`, supplies fixed `sslrootcert=system` and `gssencmode=disable`, and removes only the already-validated Prisma schema option from the libpq URL. User-supplied trust paths, GSS/host overrides, duplicate TLS keys and weaker/missing modes remain rejected. A certificate or hostname failure stops the backup before encryption/upload/output. The producer emits a logical identity digest only after successful dump and upload; the proof writer recomputes the identity and requires the same digest. The shared runtime/maintenance parser and stored credentials are unchanged.
- [`production-backup.yml`](./.github/workflows/production-backup.yml) creates scheduled PostgreSQL custom-format dumps of `public` and `app`, encrypts them with AES-256 GPG, uploads to R2, and verifies the plaintext dump checksum from object metadata. Retention is 30 days and runs only after a successful upload. The weekly isolated restore drill verifies checksum, schema/migrations, the audit chain, and application readiness against disposable PostgreSQL/Redis; a manual dispatch can also request the drill. A green isolated restore is recovery evidence, not a production restore or release proof; check the exact workflow run when relying on a specific backup.

### Release and controller status

Normal production deploys flow main push → `release-production.yml` → `deploy-azure.yml`: source qualification via [`qualify-release-source.mjs`](../.github/scripts/qualify-release-source.mjs) against the merged PR's required checks, exact-image build, disposable rehearsal, guarded rollout with smoke/traffic rollback, and worker promotion; `deploy-marketing` is independent. The `Dockerfile` builds `controller` (broker), `supervisor` and `provider-gateway` targets from one shared base with immutable product/engine labels. Worker startup (`apps/worker/src/worker-authority-startup.ts`) selects `existing-production-baseline` when no broker installation exists, selects the broker adapter only after verified installation, and fails closed on an unverifiable one. The broker serves the stored dispatch authority and the supervisor journal/grant path is wired, but no installed production authority, protected fleet/journal evidence or compatible rollback tuple exists, so the controller path remains closed to production and disposable Linux tests cannot authorize it. [PRD §8](./PRD.md#controller-integration-release-and-production-hold--2026-11-14) owns the dated hold record.

### Hosted client provenance and acceptance — 2026-11-16

Production `679021c069789ad2060f60d38b1d8261fd56b9d6` (PR #1147, successful release `43796371038`) runs app/scanner/proxy `0000523`/`0000497`/`0000363`, worker `sha256:2bbe9ace4dead4f92f07198c039a6adc40a70baacd53aeff36dd65196b49432b` and engine `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c`. All three public readiness/health probes returned 200. [PRD §8](./PRD.md#hosted-acceptance-and-client-provenance--2026-11-16-0355-utc) owns exact images, manifests, usage and acceptance receipts.

`claimOrdinaryScanOperation()` now returns the authenticated admission proof for a new OAuth claim; the scans route binds it through the existing immutable provenance path. New URL SAFE scan `cmwiqcx4x000901k576f3xqfx` has matching persisted authorization/manifest hashes and supports full hosted MCP quality reads. Historical missing provenance is not backfilled. `remote-approval-gate.ts` returns `connect_required` for hosted API-key mutations; connected read-only OAuth still fails its write-scope gate. These shared paths serve CLI/MCP/WebMCP/plugins without a new schema. Twenty live tenant/credential/MCP assertions and eleven temporary report-sharing assertions passed; fixtures were revoked/archived. Paid Standard/Deep receipts ran on preceding deployed `637a178ae`, with unchanged engine; dependency coverage remains capped at 500.

The packed CLI scan command exposed a bundled CommonJS dependency's missing `require` in ESM. `packages/cli/tsup.config.ts` now supplies Node's standard `createRequire` banner; the repaired CLI resumed the existing URL scan. Distribution smoke loads the scan command as well as help/version. Published MCP `0.2.12` lacks setup-health (21 tools); candidate MCP `0.2.13` supplies the 22-tool catalog, with matching Agent Plugin `0.1.32` and CLI `0.2.15` pins. The draft candidate has not changed public versions; npm login/publication remains required. Other native client/marketplace activation, physical-device/screen-reader, financial and broker-authority qualification remain outside these receipts.

### Current release evidence — 2026-11-16 record (released 2026-11-15 22:16 UTC)

[Release 43764099383](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43764099383) deployed merged main `637a178ae589a4545224afb1e13c4b694fefd679` ([PR #1143](https://github.com/ecryptoguru/lyrashield-ai/pull/1143), three required checks passed on head `acf00c1e4875666ff5b22c6bc031210a034b2ba4`) after source qualification, exact-image build, the disposable worker rehearsal, production migration preparation and the guarded rollout; `deploy-marketing` ran from the same source.

Independent Azure and VM readback at `2026-11-15T22:16:36Z`: app `lyrashield-app--0000521`, scanner `lyrashield-scanner--0000495` and egress proxy `lyrashield-egress-proxy--0000361` healthy at 100% traffic on web digest `sha256:a6519ad2405396ead775d8290640a7b3ed149c60d185c9c9cd7513ebe24d5126` and proxy digest `sha256:695a12e102dfedea1aff0a812f72c80b35f761af87f6eb086e93afc083211fb5`; the worker container runs image `sha256:138d435fd5b17d819bd8136ec43d8d0856434f0d93067bd9275c15749d44ea70` (active since `2026-11-15T22:14:46Z`, zero restarts) with product revision `637a178ae589a4545224afb1e13c4b694fefd679` and engine `afd71f79675cb4db4187e31ecbf8f58ebcd62e1c`. Marketing serves build revision `637a178ae`. App, scanner and scan-readiness probes returned 200; the `lyrashield:scan-admission:stopped` key was absent and every scan-queue counter was zero.

Behavior changed by this release, mapped to the modules above: `GET /api/fix-proposals` now derives `hasPatchBase` from the nested finding base commit; the deterministic-retest refusal is terminal before execution as `RETEST_BASELINE_UNAVAILABLE` via [`terminal-failure.ts`](../apps/worker/src/jobs/run-scan/terminal-failure.ts) with no charge and no queue retry; repository targets can be rebound to another owned installation through [`target-installation-rebind.ts`](../apps/web/src/lib/target-installation-rebind.ts); and failed backup/restore runs record a public-safe failure summary. The earlier `/api/ready/scans` `503` in this rollout was the documented worker-promotion admission stop and cleared on completion. [PRD current production](./PRD.md#current-deployed-production--2026-11-16-record-released-2026-11-15-2216-utc) records the limits: no paid acceptance, positive provider Fix PR/retest, screen-reader or financial qualification follows from this release. The separate deterministic fix-and-retest acceptance observed on this tuple is recorded below.

### Fix PR and deterministic retest acceptance — 2026-11-16

The first positive remediation receipt observed on deployed production, in workspace `cmrtq1zdx00000124rxffgrlg` against `ecryptoguru/lyrashield-php-acceptance-20261025` (`cmvnlqpvv000001kre6dvf24g`):

| Step             | Identity                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Originating scan | `cmvqrksed000101mb5r5v9gcz`, SAFE/deterministic 2026-10-27, revision `901f928a82a9bdbfea457870bf242599eebcb627`, manifest `73a08eaf86e5eaa675669cb86241cadffe2626dad08c8a3a200f91cfda162e08`, 15 `DETECTED` findings |
| Coverage         | `sca`, `secrets`, `agent_config`, `ml_supply_chain`, `ai_app_security` `COMPLETED`; `sast`, `iac` `BLOCKED`                                                                                                          |
| Finding          | `cmvnr1oa700140nx3viidm6s2` — `symfony/process@6.4.32`, GHSA-r39x-jcww-82v6, CWE-88, MEDIUM                                                                                                                          |
| Proposal         | `cmvqrgyph000001mb88l5t2pz` (`composer_update`, 6.4.32 → 6.4.33)                                                                                                                                                     |
| Fix PR           | [pull/1](https://github.com/ecryptoguru/lyrashield-php-acceptance-20261025/pull/1), one file `api/composer.lock`, squash-merged `30b4d018e1d4abbb69c311008a664b4a36ebe975`                                           |
| Retest           | `cmwiksnuo000501fu43qj89bx` via retest `cmwiksnx9000701fulm5c4pgy`, SAFE/deterministic, 9s, manifest `97b93c4f5597c75eefac4eecca3c3205d44b2fa0ae179d85b78eef2dd09e1513`                                              |
| Receipt          | `FIXED` / `VALIDATED` / `RETEST`, `fixedAt 2026-11-16T01:19:35.299Z`, `llmRequests: null`                                                                                                                            |

`authorizeDeterministicRetest` ([`deterministic-retest.ts`](../apps/worker/src/engine/deterministic-retest.ts)) admitted the retest because the `sca` receipt on the originating scan was `COMPLETED`, and the receipt bound the merged revision and both stored manifests. The `composer-fix/1` artifact contract ([`composer-update.ts`](../packages/fix/src/composer-update.ts)) produced the merged patch; the fix-PR route accepted no client-supplied patch, branch, title or body.

This is deterministic SCA evidence only. It is not a paid model-backed Standard/Deep acceptance, findings in the `sast`/`iac` families cannot reach `VALIDATED` on this fixture, and no screen-reader, hosted-tenant/MCP or financial qualification follows. Separately observed: a hosted MCP connection reads only scans it created (`getDelegatedScanAccess` in [`delegated-read-access.ts`](../packages/db/src/delegated-read-access.ts) binds `Scan.delegatedConnectionId`), so reading the dashboard-created originating scan returns `Scan not found` while the connection-created retest scan resolves.

### Superseded release evidence

[Release 43700283334](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/43700283334) deployed `9faf5a903090525cfcbc43dde3abd1bc7cedb2db` and was superseded by the 2026-11-16 record. Earlier releases (2026-11-02 `b03f0bbe2` and nonbilling `d488862bd`, 2026-10-31 `6739563df`, 2026-10-27 `2d4e168da`, 2026-10-10 `41462a3ff`, 2026-10-01 `4822306e2`) and the 2026-08-26 Standard/Luna acceptance are recorded in [PRD §8](./PRD.md#8-current-production-evidence); their runs and evidence remain in git. None establishes paid acceptance, a model-backed Fix PR/retest, screen-reader qualification or financial readiness.

Production migrations must survive `pgcrypto` living in the `extensions` schema: compat migrations supply an ordered, idempotent `public.digest` shim, and CI replays the full chain into a production-shaped database so the ordering cannot regress.

### Browser error collection

- `BrowserErrorMonitor` is mounted from the client tree only after optional collection permission resolves true. Unknown/denied permission and a missing public DSN do not load the SDK. The synchronous permission predicate is checked again by `beforeSend`; disabling collection detaches and disables the initialized client, and later opt-in can reattach it.
- Browser capture is limited to global error handlers. Events are rebuilt from an allowlist: bounded error class, static route template, sanitized stack filename/line, and allowlisted release/environment. Raw message, identity, request, breadcrumbs, arbitrary tags/context/extra, target URLs, and evidence are dropped; replay and browser tracing/performance sampling are disabled.
- The web image accepts optional public build variable `NEXT_PUBLIC_SENTRY_DSN`; an unset value builds a DSN-less no-op. `NEXT_PUBLIC_SENTRY_RELEASE` is stamped with the exact deployment SHA for the same public event allowlist. The DSN is a browser endpoint, not a server secret.
- Server `onRequestError` and the audit chain remain independent of optional browser collection. Server Sentry mirroring is guarded by `SENTRY_DSN`; browser preference does not suppress essential server error logging or sensitive-mutation audit records.

### Operational baseline from the superseded 2026-08-26 deployment

The `16a1fb70…` deployment (app `0000195`, scanner `0000176`, proxy `0000045`, worker `sha256:cb0f836e…`, engine `852b1ed7…`) established the baseline the runbooks still reference: TLS BullMQ `PONG` with a live heartbeat and empty queue, public Redis `6379` removed, legacy Redis stopped and restart-disabled for rollback only, direct public fetch denied while the authenticated proxy is allowed and loopback denied as `ssrf_blocked`, managed-identity license signing, exact-two admin provisioning, and encrypted backup with isolated restore. A changed OSV pin exercised the planned drain: the paid scan completed without replay, the next timer restarted the exact worker digest, and the temporary `503` is a real new-admission outage that stays alertable. Evidence-storage round-trip, tamper denial, cleanup and missing-KEK fail-closed passed. Deployment proves no hosted checkout, entitlement event or removed isolated billing deployment (retired 2026-09-08 after retained receipts).

### AI App Security coverage

- `ai-app-source-discovery.ts` ranks production/config sources ahead of tests and fixtures, excludes generated artifacts, and applies explicit mode caps: Quick/Safe 200, Standard 500, Deep/Custom 1,000.
- Discovery produces structured eligible/scanned/skipped/byte counts, skip reasons, limit codes, and a bounded representative skipped-path sample.
- `scanner-orchestrator.ts` merges discovery limits into AI scoring and provenance; `result-integrity.ts` persists the `ai_app_security` family receipt in manifest v5 and later, so bounded AI coverage cannot become a complete clean claim. Manifest v7 is current; v5/v6 remain readable.
- The scan-detail UI shows coverage counts and skipped-path samples instead of a one-line warning. A 217-file fixture proves Quick stays at 200 with 17 skipped while Standard scans all 217.

## 12. Key files

| File                                                    | Purpose                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/web/src/proxy.ts`                                 | CSP, rate limit, trusted client IP                                                  |
| `apps/web/src/lib/api-client.ts`                        | Typed client requests                                                               |
| `apps/web/src/lib/api-response.ts`                      | Typed server responses                                                              |
| `apps/web/src/app/api/scans/route.ts`                   | Scan admission and creation                                                         |
| `apps/web/src/app/api/api-keys/`                        | ADMIN+ browser-session API-key create/list/revoke routes                            |
| `apps/web/src/app/(dashboard)/dashboard/settings/`      | Settings route and API-key management UI                                            |
| `apps/web/src/app/billing/webhook/route.ts`             | Polar/Razorpay idempotent webhook boundary                                          |
| `apps/web/src/lib/licenses/license-service.ts`          | Production signing boundary                                                         |
| `apps/worker/src/jobs/run-scan.job.ts`                  | Scan orchestration entry; delegates to `run-scan/` phases                           |
| `apps/worker/src/jobs/run-scan/`                        | Scan lifecycle phases (authority, preparation, execution, settlement, finalization) |
| `apps/worker/src/engine/runner.ts`                      | Bounded/cancellable engine subprocess                                               |
| `packages/security/src/engine-command.ts`               | Shared trusted engine arguments                                                     |
| `apps/worker/src/engine/command-builder.ts`             | Worker command environment and budget policy                                        |
| `apps/worker/src/engine/gpt6-pricing.ts`                | GPT-6 rate cards and per-request cache usage accounting                             |
| `apps/worker/src/engine/scanner-orchestrator.ts`        | Deterministic and engine result merge                                               |
| `apps/worker/src/engine/result-integrity.ts`            | Manifest/candidate/receipt boundary                                                 |
| `packages/db/src/api-key-service.ts`                    | Workspace API-key creation, listing, revocation, and verification                   |
| `packages/db/src/manifest-checksum.ts`                  | Stored manifest hash and JSONB integrity verifier                                   |
| `apps/worker/src/operations/verify-launch-assurance.ts` | Host-side dry-run-first launch-assurance orchestrator                               |
| `ops/monitoring/provision-alerts.sh`                    | Actionable Azure alert provisioning with readback                                   |
| `ops/worker/run-worker.sh`                              | Worker VM launcher with provenance derivation                                       |
| `packages/integrations/src/queue.ts`                    | Shared queue authority                                                              |
| `packages/db/prisma/schema.prisma`                      | Executable data model                                                               |
| `packages/db/src/scoping.ts`                            | AsyncLocalStorage and scope policy                                                  |
| `packages/db/src/rls.ts`                                | Transaction-local RLS context                                                       |
| `packages/db/src/scan-transitions.ts`                   | Lifecycle guards                                                                    |
| `packages/db/src/score-service.ts`                      | Score persistence/public payload boundary                                           |
| `packages/security/src/safe-fetch.ts`                   | Redirect-safe pinned fetch                                                          |
| `packages/mcp/src/prompt-injection-guard.ts`            | Model-input guard                                                                   |
| `ops/worker/*`                                          | Worker VM services, secrets, egress, promotion, verification                        |
| `.github/workflows/ci.yml`                              | Main release gate                                                                   |
| `.github/workflows/deploy-azure.yml`                    | Migration-first Azure deployment                                                    |

CI's app, marketing and Desktop browser sites use `.github/scripts/ci-browser.mjs` to run the unchanged selected Playwright suites with local Chromium. Font assets come from the digest-pinned official Playwright 1.62.1 Jammy amd64 image: a bounded regular-file archive includes a SHA-256 manifest, and extraction rejects traversal, duplicate, link, sparse and special entries. A private Fontconfig overlay retains host rules and uses verified image fonts and a private cache; it does not install apt packages or copy image configuration or libraries. Startup independently verifies the locked headless shell used by all selected CI suites, every font asset, required font families, native libraries and native WebMCP, including a short local trace cleanup probe. The image container is nonroot, read-only, capability-free and network-disabled, with no host mounts or credentials; it extracts fonts and provides only the bounded synthetic FFmpeg fallback when host `lavfi` and `libx264` fail validation. Every browser job removes its owned container, font overlay and temporary FFmpeg wrapper, including failed startup. Required check routing, auth-mail privacy guards and marketing failure diagnostics remain in force.

## 13. Landmines

See [AGENTS.md](./AGENTS.md#landmines) for the current engineering rules and operational landmines.
