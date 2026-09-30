# LyraShield Cross-Repository Review and Hardening Implementation Plan

> **Execution status:** The founder authorized implementation and local Docker testing on 30 September. Source corrections and local verification are in progress on isolated branches. Merge, production release, signed Desktop release, package publication, and paid provider acceptance remain separate gates. Checked criteria have current evidence; unchecked baseline, operational and release criteria remain explicitly unresolved. See the execution ledger for evidence and limits.

**Date:** 30 September 2026

**Goal:** Correct the source-backed reliability and UX defects identified in this review, preserve existing security/accounting contracts, and make release readiness independently verifiable.

**Architecture:** Keep the existing product, engine, and generated marketplace boundaries. Introduce narrowly scoped corrections, durable retry ownership, and atomic UI state transitions rather than a platform rewrite. Ship immutable, compatible revisions with explicit rollback and acceptance evidence.

**Tech stack inspected:** TypeScript/React/Next.js, Prisma/PostgreSQL, BullMQ/Redis, Python engine, Node marketplace validation, Rust Zed adapter.

**Spec:** The original cross-repository review scope: fix issues carefully, improve UX/DX, and avoid regressions. The 30 September follow-up requests authorize reviewing this document, implementing its corrections, and testing the services in Docker. The findings and invariants below define that scope.

## Execution ledger

Current results and remaining release gates are recorded in [execution-results.md](./execution-results.md). Historical review statements below describe the starting snapshot, not the completed test surface.

## 1. Review baseline and evidence boundary

| Repository                         | Reviewed / freshly fetched `origin/main` revision |
| ---------------------------------- | ------------------------------------------------- |
| ecryptoguru/lyrashield-ai          | `9b548984fcecd0a2a5c675800af79ec057a9969a`        |
| ecryptoguru/lyrashield-engine      | `827ea1e590856ee7984756ec31041b35cc58ca14`        |
| ecryptoguru/lyrashield-marketplace | `8d3d418a1f8dbfa6f5ab2004e728b7731ddb77f3`        |

The GitHub record for product production release `36612020939` was rechecked and reports success at product revision `9b548984...`, last updated `2026-09-29T18:55:47Z`. This establishes the recorded release result, not a new live end-to-end acceptance test. Engine's reverse consumer pin at the reviewed revision points to the same product revision. Product main's Cloud (`.github/workflows/deploy-azure.yml`) and Desktop (`.github/workflows/release-tauri.yml`) workflows both pin engine `c2fb19595bdefa0eda52d09ccd2aaeabcca575ae`; engine main is a separate revision and must not be assumed to be the deployed engine. LS-06's response-framing code is also present at that pinned engine revision. The marketplace main manifest declares plugin version `0.1.30`, release-candidate status, and source commit `7e758cbcc4ebd0d5cd32a1067dbab784c51d53c9`.

**Performed:** risk-focused source inspection across all three repositories, integration/caller/test inspection, dependency-lock inspection, release-record verification, and comparison against primary upstream documentation. Some large files were inspected in bounded sections; this is not a claim that every repository line was read.

**Not performed in the original review:** repository test execution, a complete dependency installation/build, browser accessibility or performance measurement, new production scans, database queries/writes, provider checkout/refund transactions, application source edits, merges, package publication, or deployment. No current production incident is inferred solely from a suspicious branch. No exploitability claim is made without an established input path.

### 1.1 Follow-up verification and local divergence

On 30 September, all three `origin` remotes were fetched successfully. The main revisions above are unchanged. Targeted source/schema/caller comparisons and the official Next.js advisory were refreshed. During the review, concurrent cleanup moved the original dirty product checkout into `/Users/defiankit/.codex/worktrees/recovery-v22-local-20260930/lyrashield-ai` and switched the primary checkout to clean main `9b548984...`. This plan is updated in that recovery worktree; no application changes from this review were applied.

| Checkout at the start of this follow-up                                     | Local HEAD                                 | Relevant divergence from main                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product, `codex/v22-implementation`, now preserved in the recovery worktree | `55b59967ff4e9616e6ff6348b01417fd27d3f929` | Extensive tracked and untracked local work; this plan is untracked. Quick profile has 17 engine / 20 total minutes; main has 20 / 23. `use-scan-list-state.ts` is absent, with state in `scans-client.tsx`. Local release pins are `21ce6688b8bc39c88822a0e1792b9be08dca8a07`. |
| Engine, `codex/v22-engine`                                                  | `0e307340857d7dbdc105b7ea37fb29c0bdd8f099` | Tracked tree clean; reverse pin is `c372685bde37a566ac75a7ac204239b4547930ad`, not current product main.                                                                                                                                                                       |
| Marketplace, `codex/v22-marketplace`                                        | `542c0cbaf819233c646e43b9c05bd2390fb2f84c` | Untracked `.worktrees/`; local manifest has `sourceCommit: null`, `publication.status: unpublished`, and `sourceClean: false`. It is not the clean main release candidate.                                                                                                     |

Do not execute this plan blindly against older branch contents or overwrite user work to align them. Select a clean implementation base and reconcile relevant branch differences. Retain main's scan-list request guards, Quick limits, ID-only queue-position reads (`getRanges`, versus local `getJobs` hydration), and subprocess lifecycle-script suppression (`npm_config_ignore_scripts: "true"`, absent locally). These differences require reconciliation before any recovered work ships; this follow-up did not fix them.

**Focused check run:** `pnpm exec vitest run packages/integrations/src/queue.test.ts packages/billing/src/webhook-tracks.test.ts packages/billing/src/usage/meter.test.ts apps/worker/src/jobs/webhook-track-retry.job.test.ts` — **4 files / 45 tests passed** against the original local product checkout and its installed dependencies, before cleanup. These are mocked unit tests; they neither reproduce real BullMQ/Redis identity behavior nor establish PostgreSQL transaction correctness. A separate direct assertion against the installed BullMQ `Job.prototype.validateOptions` confirmed rejection of `event1:billing` without Redis I/O. No full suite, build, browser, real-service integration, live runtime, or provider acceptance was run in this follow-up. Implementation tasks remain open.

**Document checks:** Prettier and repository Markdown rules passed. All 35 pinned repository source links resolve to Git objects, and all 14 listed product scripts exist on reviewed main. The untracked plan produced no whitespace diagnostics under `git diff --no-index --check`; its difference exit status is expected when compared with `/dev/null`.

## 2. Global constraints

- Preserve Quick and Standard engine limits of **20 minutes**, total windows of **23 minutes**, and **3-minute scanner reserves**. Preserve the existing worker-to-engine finalization margin; do not shorten or reset the deadline in nested work.
- Preserve repository hard provider-budget caps: **Quick $1.20**, **Standard $3.20**. Do not confuse these ceilings with expected cost or customer prices.
- Keep provider spend and internal settlement details out of customer/public payloads. Preserve private raw usage, calculated costs, search components, and reconciliation provenance.
- Failed scans remain unbilled to the customer. Completed, cancelled, partial, Deep, and Custom outcomes must retain the existing approved wall-clock/minute-rounding rules unless a separate product decision changes them.
- Sponsor identity comes from persisted admission state, not a queue payload. Retain account ownership and workspace attribution, RLS, advisory-lock ordering, and permission boundaries.
- Ambiguous financial commits must not trigger automatic provider-work replay or retroactive charges. Preserve terminal evidence and escalate unresolved accounting.
- Keep evidence grades distinct: detected, independently verified, retest-confirmed, inconclusive, and missing evidence must not collapse into a generic success state.
- Preserve TLS verification, target ownership/scope checks, sandbox limits, approval gates, secret redaction, and immutable evidence checksums.
- Use additive, forward-compatible migrations. Do not use production `db push`, destructive migrations, blanket queue purges, or bulk billing replays as remediation.
- Marketplace is an export. Edit authoritative product sources and regenerate into an empty staging directory; do not hand-edit exported artifacts or their hashes.
- Preserve unrelated/uncommitted work. Use isolated branches/worktrees and small PRs. No direct main pushes or automatic production authorization is implied by this plan.
- Preserve managed Redis efficiency controls on main: three BullMQ workers, 600-second idle drain delay, 120-second stalled checks, 120-second scan heartbeat, single-key Lua readiness/heartbeat, and ID-only queue-position reads. Do not add workers, QueueEvents listeners, faster polling, or new production test clients solely for these fixes.
- Record matched before/after Redis commands, bandwidth, storage, connections, and budget headroom. Healthy idle usage should not materially increase. Bound legitimate retry/recovery bursts with due-only database selection and the existing five-attempt policy; a newly functioning retry consumes real queue work even if the old broken retry consumed little. Run failure-injection tests against disposable Redis, never the production quota.

## 3. Review focus

The implementation must explicitly exercise these input/failure classes:

1. Worker death or network ambiguity between side effects, evidence persistence, queue acknowledgment, and monetary commit.
2. Duplicate or concurrent delivery through both provider webhooks and worker retries.
3. Filter changes, pagination, tab visibility changes, and stale responses arriving out of order.
4. Mixed deployed versions: old queue payloads, previous worker images, current engine contracts, and published MCP clients.
5. Untrusted headers, report strings, plugin child-process output, and secrets embedded in errors.

## 4. Findings register

### LS-01 — P1: Webhook retry scheduling violates queue identity semantics

**Files:** `packages/integrations/src/queue.ts`; `apps/worker/src/jobs/webhook-track-retry.job.ts`; `packages/billing/src/webhook-tracks.ts`; `apps/worker/src/jobs/billing-reconciliation.job.ts`; `apps/web/src/app/billing/webhook/route.ts`; `packages/db/prisma/schema.prisma`; their adjacent tests.

**Observed:** Retry jobs use `${webhookEventId}:${track}`. BullMQ documents that custom IDs must not contain `:`. The retry worker also attempts to enqueue the same event/track ID while processing the currently active job, then returns `reEnqueued: true`. Existing IDs are deduplicated; changing only the separator does not repair this second failure. Completed-job retention can continue suppressing later additions. The inspected queue tests mock `Queue.add`, and therefore do not exercise either behavior.

The main lockfile pins BullMQ **6.2.0**; the installed package's validation rejects this two-part colon ID with `Custom Id cannot contain :`. Inline ingress and retries both read attempt counts before executing handlers, and `markTrackFailed` has no terminal-status guard. Concurrent handlers can overwrite success or lose attempt increments. The recovered older branch contains a `reEnqueueIncompleteTracks` sweep, but main's `billing-reconciliation.job.ts` is deliberately report-only and never retries tracks. Do not port the older sweep into that provider reconciliation job. Interrupted retry handoffs need a separate bounded, due-only recovery path using existing worker maintenance infrastructure.

**Impact:** A required billing, license, or affiliate track can remain failed without the intended next worker attempt. Provider redelivery and other recovery mechanisms may mask this; a platform-wide payment failure was not demonstrated. Durable failed-track rows remain available for controlled recovery.

**Fix:** Make retry generations durable and uniquely identified, with one database claim shared by ingress and retry consumers. Use colon-free deterministic IDs per generation. Atomically reserve attempts under the existing five-attempt cap, including inline ingress attempts; persist the due generation before enqueue so bounded recovery can repair an interrupted handoff. Keep provider reconciliation report-only. Bind completion/failure updates to the claim token and generation. Define lease expiry and stale-owner handling without allowing a resumed old handler to overwrite a newer result. Success/dead-letter states must never be downgraded by a late competing handler. A claim alone cannot guarantee exactly-once external effects after a crash; preserve domain/provider idempotency and reconcile ambiguous effects against receipts before retrying them.

**Required proof:** Real pinned BullMQ + Redis + PostgreSQL integration tests, not only mocked queue calls. Exercise multiple failures followed by success, concurrent provider redelivery, duplicate generation enqueue, retained completed jobs, crash before/after enqueue, and terminal dead-letter behavior. Verify one set of external/domain side effects and truthful enqueue status.

### LS-02 — P1 security maintenance: Runtime Next.js is below a published patch floor

**Files:** `apps/web/package.json`; root `package.json`; `pnpm-lock.yaml`; `pnpm-workspace.yaml` (authoritative overrides); the two public OG route implementations.

**Observed:** Web's lockfile resolves Next.js **16.3.4**. Advisory **GHSA-vcvr-r3jv-pc5j / CVE-2026-94545**, published 22 September 2026, lists `>=16.2.0 <16.3.6` as affected and `16.3.6` as patched. The score and Lite OG endpoints use Node `ImageResponse`.

**Exposure boundary:** The advisory requires attacker-controlled values reaching SVG content, attributes, or styles. The inspected routes render constrained DIV-based templates; this review did not establish that required exploit path. This is an installed vulnerable-range dependency, not proof of remotely exploitable LyraShield RCE.

**Fix:** A separate security PR must update the runtime Next dependency, compatible Next tooling, override floor, and resolved lockfile to a patched 16.x version at least 16.3.6. Recheck the official advisory when implementing. A tooling-only upgrade is insufficient.

**Required proof:** Confirm resolved runtime version and resulting image contents; build the app; exercise authentication/routing; render real PNG output for wide/square/portrait and grade/fixes variants, Lite tokens, missing/revoked cards, and malicious-looking text. Do not replace real rendering with only an `ImageResponse` mock. Preserve revocation-sensitive cache behavior.

### LS-03 — P1: Billing treats any P2002 as proven idempotent replay

**Files:** `packages/billing/src/usage/meter.ts`; `apps/worker/src/jobs/run-scan/settlement.ts`; billing usage tests.

**Observed:** The catch surrounding the serializable metering transaction returns an idempotent-looking result for every Prisma `P2002`, without verifying the violated constraint or reading a matching durable usage receipt. The transaction also includes overage handling and a finalization callback. An unrelated unique conflict or a callback error with this code can therefore be mistaken for a successful previous settlement. The shortcut returns zero overage even though an actual existing receipt may record overage.

**Impact:** Error suppression and accounting ambiguity; no production ledger loss or overcharge was established in this review.

**Fix:** Only classify a receipt-insertion conflict as a replay after an authoritative account-scoped receipt lookup validates the expected account, workspace, scan, phase-bound idempotency key, usage kind, and non-deleted state. Apply the same validation to the normal pre-existing-receipt branch, which currently selects only `id` and `metadata`. Reject unrelated constraints or absent/mismatched receipts. Preserve receipt metadata. A matching usage receipt does not prove that a finalization callback succeeded: propagate callback-originated failures and keep terminal/evidence recovery separate from monetary replay. Never rerun provider work as part of receipt recovery. Keep the existing conservative treatment of uncertain financial commits.

**Required proof:** Genuine replay, unrelated unique constraint, missing receipt, finalizer-originated conflict, stored overage metadata, cross-account mismatch, rollback, serialization retries before finalization, and no retry after durable finalization starts. Run transaction/crash scenarios against real PostgreSQL.

### LS-04 — P2: Filtered polling drops loaded pages but keeps their cursor

**Files on main:** `apps/web/src/app/(dashboard)/dashboard/scans/use-scan-list-state.ts`; `use-active-scans-polling.ts`; related list utilities/tests. The recovered older branch keeps list state in `scans-client.tsx`; reconcile the implementation base before choosing edit targets.

**Observed:** Filtered polling replaces the displayed list with the new first page. The polling hook cannot update `nextCursor`, which remains owned by the other hook. After loading two pages, a poll can leave first-page rows with the cursor for the end of page two.

**Concrete scenario:** In a filtered view containing an active scan, display rows 1–50, with the next cursor after row 50. A filtered poll replaces the visible set with rows 1–25. “Load more” then requests rows after 50, skipping 26–50.

**Fix:** The list-state owner must accept rows and cursor together and coordinate query identity/request generation across polling, load-more, and manual refresh. Reuse main's existing request guards and a shared first-page acceptance operation first; introduce a reducer only if needed for that ownership. Reset filtered results and their cursor together when replacing page one, and invalidate pending load-more responses. Make that reset understandable rather than silently misrepresenting a preserved multi-page view. A later measured enhancement may reconcile all loaded pages without losing filter correctness.

**Required proof:** Two loaded pages followed by a poll and another load; no missing/duplicate rows; active-to-terminal filter changes; unchanged 304 responses; stale load-more responses; manual-refresh/poll ordering; workspace/filter changes; unmount; hidden-tab resume.

### LS-05 — P2: Invalid-target recovery drops a valid status filter

**File:** `apps/web/src/app/(dashboard)/dashboard/scans/page.tsx`.

**Observed:** When a target filter is invalid, the fallback calls `listScans({ workspaceId, limit })`, dropping status constraints. The client still receives the original `initialStateFilter`.

**Concrete scenario:** `?target=<deleted-target>&state=NEEDS_ATTENTION` can render completed scans while the interface says Needs attention. This is not a cross-workspace authorization bypass; the fallback remains workspace scoped.

**Fix:** Remove only the invalid target constraint; preserve valid state constraints. Reuse the same normalized filter-to-query mapping for the normal and fallback branches.

**Required proof:** Deleted, malformed, and foreign-workspace target IDs paired with each supported state filter; correct rows, selected filter, cursor, and recovery notice; no unnecessary polling required to repair initial SSR output.

### LS-06 — P2: Engine relay changes HEAD/304 metadata and emits forbidden 204 framing

**File:** `lyrashield/runtime/target_relay_proxy.py`.

**Observed:** The relay strips incoming `Content-Length`, buffers the response, then always emits the length of the buffered body. HEAD reads no body, so a real representation length becomes zero. 304 has similar representation-length semantics; 204 must not carry Content-Length. The response side also lacks the request side's filtering of header names nominated by `Connection`.

**Impact:** Distorted HTTP evidence and inaccurate downstream observations. This is not evidence of a target-scope escape or TLS bypass.

**Fix:** Use method/status-aware response framing. For HEAD and 304, preserve a valid applicable representation length or omit it; never fabricate zero from the absence of a response body. Omit Content-Length where forbidden, including 1xx and 204; forward no body for HEAD, 1xx, 204, or 304. For ordinary bounded bodies, calculate the actual outgoing byte length. Strip response connection-specific headers, including nominated header names from every `Connection` field. Never preserve a length nominated as hop-specific. Do not weaken existing target scope/TLS/body-size controls.

**Required proof:** Real loopback relay tests for GET versus HEAD, 204, 304, chunked responses, duplicate/invalid length handling, oversized replies, connection-nominated headers, and transport errors. Verify coverage becomes inconclusive/failed appropriately rather than falsely complete after transport failure.

### LS-07 — P2: Marketplace verifier does not enforce its apparent process deadline

**Authoritative source:** `lyrashield-ai/docs/marketplace/scripts/verify-published-mcp.mjs`.

**Exported copy:** `lyrashield-marketplace/scripts/verify-published-mcp.mjs`.

**Exporter:** `lyrashield-ai/packages/agent-plugin/src/export.ts`.

**Observed:** Registry metadata fetch is bounded, but `npm pack` has no process timeout. The npx subprocess has piped stderr that is never consumed, a growing stdout buffer, and a timeout that sends SIGTERM without guaranteed process-tree cleanup or independent promise settlement. Success checks an initialize result and a tool count threshold, not the required client tool/schema contract.

**Impact:** Release verification can block or provide weaker assurance than the supported integrations require. No failed marketplace installation was demonstrated.

**Fix:** Bound all child-process phases, drain/redact stderr, cap frame/buffer sizes, handle stdin errors, settle once, and terminate only the owned process tree with escalation. Test the verified package artifact rather than relying on an unrelated second acquisition path. Use an allowlisted child environment, isolated npm configuration/cache, and an explicit registry; inherited CI/provider credentials must not reach package execution. Suppress lifecycle scripts for pack and install/execute phases, preserving main's existing suppression. Verify required tool names and compatible schemas, not merely a count. Keep strict stdout JSON-RPC and integrity checks.

**Required proof:** Hanging pack process, stderr flood, malformed/oversized stdout, missing tool, incompatible schema, ignored SIGTERM, descendant holding pipes open, integrity mismatch, and healthy initialization. Add fixture-backed authenticated capability tests separately from unauthenticated package-startup checks.

### LS-08 — P2 validation risk: HTTP producers inherit indefinite Redis retry behavior

**Files:** `packages/integrations/src/queue.ts`; worker connection wiring; admission callers in `apps/web/src/app/api/scans/route.ts`, GitHub webhook/retest routes, and `apps/worker/src/schedules.ts` / `loop-closure-sweep.job.ts`.

**Observed:** Queue producers share connection options containing `maxRetriesPerRequest: null`. BullMQ recommends persistent retry behavior for workers but bounded failure behavior for HTTP producers. Readiness can succeed before Redis becomes unavailable during `queue.add`.

**Boundary:** A user-visible production hang was not reproduced. The complete admission recovery path must be tested before changing behavior.

**Fix:** Separate producer and consumer policies. Bound connection establishment, offline-queue behavior, command retries, and command response time while keeping worker reconnection semantics. A finite `maxRetriesPerRequest` alone does not establish a wall-clock bound. Apply the producer policy to all shared queue factories, including fix generation and webhook tracks; worker-hosted producers still need it. An uncertain enqueue must retain the same durable admission operation/idempotency key. Trace existing enqueue-failure status updates and terminal-job guards before changing customer recovery; do not auto-requeue ambiguous paid work. A simple Promise.race around an indefinitely retrying enqueue is not sufficient: it can leave an unseen operation that later succeeds.

**Required proof:** Redis fails after readiness, unavailable startup, slow/recovered connection, enqueue acknowledged after client timeout, duplicate HTTP submission, and worker restart. Show bounded customer response and at most one admitted scan.

## 5. Implementation sequence

Each task follows: characterization test fails for the intended reason → minimal correction → focused tests → relevant integration tests → full required checks → independent review → small PR. Do not mark a task complete because a mocked unit test passes.

### Task A — Capture an executable baseline and protect current fixes

**Files:** Existing repository test harnesses; new review evidence under `docs/reviews/2026-09-30/` in the implementation branch. File lists originated as proposals; the execution ledger records the resulting changes and verification.

- [x] Record exact main/head SHAs, engine pin/reverse pin, dirty-tree status, image digest, lockfile hashes, and active queue payload versions. Preserve the recovery worktree and user-owned files; use fetched main for implementation unless a specific recovered change is intentionally ported.
- [ ] Run the existing product, engine, and marketplace checks at the starting revisions. Separate pre-existing failures from changes introduced by this work.
- [x] Reuse existing scan-profile/fixture tests for Quick/Standard 20/23/3 limits and add only missing assertions for finalization headroom, customer-minute policy, cost privacy, and evidence-state semantics. Do not restore recovered 17/20/3 Quick values or older engine pins accidentally.
- [ ] Snapshot public scan DTO and MCP schemas. Include old valid payloads so contract-preserving changes are tested rather than assumed.
- [x] Produce a gate ledger with `pass`, `fail`, `not-run`, and `blocked`; attach command output and revision to each entry.

### Task B — Patch the Next.js runtime floor independently

**Modify:** `apps/web/package.json`, root `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`.

**Exercise:** Both OG route files and normal auth/dashboard routing.

- [x] Add a dependency-resolution assertion that rejects a runtime version below the advisory's patched floor.
- [x] Record failing baseline evidence without attempting a production exploit.
- [x] Update the runtime dependency and compatible tooling/overrides together, within the current major.
- [x] Verify real OG rendering and malicious-looking strings; preserve shape, dimensions, headers, 404 behavior, and revocation behavior.
- [x] Build and inspect the exact image/package resolution.
- [ ] Merge this independently of broad dependency maintenance.

### Task C — Repair webhook retries and shared execution ownership

**Modify:** `packages/integrations/src/queue.ts`, `packages/billing/src/webhook-tracks.ts`, `apps/worker/src/jobs/webhook-track-retry.job.ts`, existing worker maintenance wiring, `apps/web/src/app/billing/webhook/route.ts`, adjacent tests. Preserve the report-only contract of `billing-reconciliation.job.ts`. `WebhookEventTrack` currently has status, attempts, and timestamps but no due generation or lease/token; add only the additive schema/migration needed after checking reusable claim patterns.

**Proposed interface responsibility:** A shared billing-domain claim operation returns `claimed`, `busy`, `terminal`, or `missing`, with the durable generation and ownership token for a claimed attempt. Both inline ingress and worker retries must use it. Queue submission accepts the generation and reports whether it is represented in the queue. Claim that it was newly enqueued only if the pinned BullMQ API supplies authoritative evidence; a returned job ID or check-then-add sequence does not prove that. Reconciliation counters must follow the same semantics.

- [x] Reproduce the current same-ID scheduling failure using the pinned real queue library.
- [x] Test a second execution path arriving while the first owns the claim. Assert no duplicate handler execution and no terminal-state downgrade.
- [x] Test atomic attempt reservation across ingress and workers, lease expiry during slow handlers, stale-owner completion, and crash after an external effect but before the track receipt. Preserve handler idempotency; unresolved external effects require receipt-aware recovery.
- [x] Introduce colon-free IDs derived from event, track, and durable generation; preserve stable deduplication within a generation.
- [x] Persist next-due retry state before queue handoff; add bounded, due-only database recovery through existing worker maintenance, respecting generation, ownership, and terminal states. No new idle BullMQ consumer is needed. Do not extend the five-attempt budget or convert provider reconciliation into an automatic billing replay.
- [x] Verify healthy success, repeated failures/dead-letter, restarts, duplicate deliveries, and queue retention semantics with PostgreSQL/Redis.
- [ ] Inventory existing unsatisfied tracks and prepare a receipt-aware recovery report. Recovery execution is a separate controlled action, not a blanket replay.
- [ ] For rollout, pause/drain the affected retry consumer and coordinate with ingress compatibility so old writers cannot bypass new claim ownership. Do not drain or restart unrelated paid scans unnecessarily.

### Task D — Make metering replay evidence authoritative

**Modify:** `packages/billing/src/usage/meter.ts` and focused unit/PostgreSQL tests. Touch settlement only where a typed uncertainty result requires it.

**Proposed interface responsibility:** Receipt verification takes the expected account/workspace/scan/phase/idempotency identity and returns a validated persisted receipt or an explicit absence/mismatch. It must not run scan work or mutate provider-side state.

- [x] Inject P2002 from the expected unique key, an unrelated key, and the finalization callback.
- [x] Require an authoritative fresh receipt read after a rolled-back transaction before returning replay success; validate the normal existing-receipt branch too, including `kind`, `deletedAt`, ownership, metadata scan ID, and phase-bound key.
- [x] Keep a matching usage receipt from hiding finalizer-originated P2002 or another finalization failure. Do not re-invoke the callback or provider work as receipt recovery.
- [x] Preserve stored overage/account metadata; refuse mismatched ownership.
- [x] Verify partial evidence success plus failed monetary commit does not cause double execution or automatic retrospective charging.
- [x] Exercise real transaction rollback, serialization contention, and concurrent settlements for one account across workspaces.
- [x] Compare ledger totals, pack balances, and terminal evidence before/after on fixture accounts.

### Task E — Bound producer failure without introducing late duplicate scans

**Modify:** Producer connection factory and existing admission error/recovery path; add real Redis failure-injection tests.

- [x] Reproduce disconnection after worker readiness but before/during enqueue.
- [x] Separate producer and worker connection policies across scan, fix-generation, and webhook queues. Keep worker persistent reconnect unchanged; cover HTTP and worker-hosted producers.
- [x] Establish a proposed **5-second queue-I/O response budget**, subject to the measured admission baseline. Enforce it with bounded underlying operations, not just a detached timeout wrapper.
- [x] Distinguish definitive rejection from uncertain admission. Preserve the original operation ID and same-key recovery.
- [x] Characterize each admission caller's current enqueue-error transition and worker terminal-job guard before altering recovery. Retain fail-closed behavior and never automatically revive ambiguous paid scans.
- [x] Test recovered Redis and late acknowledgments produce one scan, one terminal settlement, and understandable client recovery.

### Task F — Repair scan list state and simplify recovery UX

**Modify on main:** `use-scan-list-state.ts`, `use-active-scans-polling.ts`, scan list utilities, `page.tsx`, adjacent tests. Preserve main's extracted hook and request guards; do not rebuild from the recovered monolithic `scans-client.tsx`. A new reducer module is optional, not required scope.

**Required ownership:** Cursor and rows change in the same accepted transition. A response must match its query/request generation; both polling and manual requests participate. Reuse `listRequestRef`, `firstPagePendingRef`, `loadMoreRequestRef`, and first-page metadata ownership where practical. Reset the polling ETag when a replacement/query invalidates its baseline; a subsequent 304 must not retain stale rows or cursor.

- [x] Add a failing two-page → filtered poll → load-more test that demonstrates skipped rows.
- [x] Apply atomic first-page replacement including its cursor, invalidate outstanding page requests, and deduplicate accepted rows.
- [x] Add a failing SSR fallback test for invalid target plus valid status filter; preserve that status constraint.
- [x] Exercise old responses after filter/workspace changes, hidden-tab resume, 304, cancellation, removal, and manual refresh.
- [x] Preserve form values after recoverable errors and surface a single primary recovery action. Do not discard accepted-submission recovery state.
- [x] Verify keyboard navigation, focus return from the create sheet, announced error/status messages, mobile widths, and reduced motion in the real browser.

### Task G — Correct relay framing, then update the product consumer pin

**Modify:** `lyrashield-engine/lyrashield/runtime/target_relay_proxy.py`; extend `tests/test_target_relay_proxy.py` using a local fixture origin. Start from engine main, and compare compatibility against product main's pinned `c2fb19595bdefa0eda52d09ccd2aaeabcca575ae`. Update product engine pin only after engine verification.

- [x] Write red tests for HEAD length, 204 framing, 304 length semantics, and response connection-nominated headers.
- [x] Introduce the smallest method/status-aware header assembly change. Preserve fixed relay destination and scope enforcement.
- [x] Run GET/body-limit/transport/TLS regression tests and the full existing engine contract suite. Follow `scripts/verify-controlled-derivative.sh`, including its frozen dependency installation with `--extra viewer`; do not omit the optional viewer needed by the complete suite.
- [x] Run product parser/worker compatibility against the exact candidate engine revision, including old durable output fixtures.
- [ ] Merge engine change, update both Cloud and Desktop product pins in a reviewed PR, then update engine's reverse consumer pin to the exact merged product revision after compatibility proof. Build/promote the Cloud worker only through founder-dispatched release; signed Desktop release and installed-client acceptance remain separate gates.
- [x] Treat a pin-only reverse update as provenance alignment, not a reason for an endless runtime pin-bump cycle.

### Task H — Harden marketplace verification at the source and regenerate

**Modify authoritative source:** `docs/marketplace/scripts/verify-published-mcp.mjs`; source validation rules if the verifier contract changes; `packages/agent-plugin/src/__tests__/export.test.ts`.

**Regenerate:** Public marketplace artifact tree and manifest via `packages/agent-plugin/src/export.ts`.

- [x] Add fixture subprocesses for hangs, stderr floods, malformed frames, ignored termination, and open descendant pipes. Fixtures must not access production credentials or networks.
- [x] Bound registry acquisition, pack/install, and handshake separately. Proposed process limits: pack/install 60 seconds; handshake 30 seconds; terminate owned process tree after a 2-second graceful window. These are implementation acceptance targets, not measurements of current runtime.
- [x] Drain/redact stderr and limit retained diagnostics; cap an incomplete JSON-RPC frame at 1 MiB. Settle the orchestration promise exactly once on success/error/timeout.
- [x] Execute the verified artifact under a controlled registry/environment; keep lifecycle-script suppression and integrity identity checks.
- [x] Do not spread `process.env` into package subprocesses. Allow only needed platform variables and synthetic test credentials; isolate npm home/config/cache and prove secrets are absent. Cap registry metadata and archive acquisition as well as child output; reject archive paths outside the owned staging directory.
- [x] Validate a versioned required subset of tool names and compatible schemas. Additional legitimate tools must not fail compatibility solely because their count changed.
- [x] Export from a clean product checkout into a new empty staging directory; run `node scripts/validate.mjs` there before building derived artifacts.
- [x] After the Zed build, run `node scripts/validate.mjs --release` to validate release assets. Confirm manifest hashes, source commit, clean-source state, and immutable publication status; never promote the recovered `sourceCommit: null` / unpublished export directly.
- [ ] Prove hosted OAuth and local stdio separately: valid login/credential, expiration, revocation, insufficient scope, workspace boundary, and forbidden mutation. Package initialization alone is not authenticated-client acceptance.
- [x] Update client pins only after the exact package version is published and verified.
- [ ] Publish/tag only through the existing authorized immutable-release workflow.

### Task I — Optimize only the measured hot paths

This is a deferred, measurement-gated follow-up, not a prerequisite for closing LS-01–LS-08. Capture a baseline first; skip each optimization if it has no demonstrated material benefit. Measurements and thresholds below do not authorize paid/provider runs.

**Billing reads:** `packages/billing/src/usage/meter.ts`. If measured transaction/lock duration warrants it, replace per-record transfer plus JavaScript summation with database aggregates while preserving exact account, kind, soft-delete, and cycle semantics. Inspect query plans before adding indexes.

**Queue position:** `packages/integrations/src/queue.ts`. Main already fetches only waiting/delayed/prioritized IDs with `getRanges`; preserve that improvement. If measured queue size/Redis work warrants it, bound the range or use a short-lived shared queue snapshot in the queue authority. Do not present mixed delayed/priority sets as a guaranteed runnable order. Prefer an honest waiting state over a fabricated exact rank.

**Create-scan UI:** `scans-client.tsx` and `create-scan-sheet.tsx`. Measure route bundle and interaction cost before lazy-loading the create sheet or separating recovery logic. Preserve SSR parity, deep links, accessibility, and accepted-submission handling. Source file size alone is not evidence of bundle cost.

**Engine efficiency:** Measure queue/startup, engine/model wait, scanner, and finalization phases at matched target SHA and configuration. Compare warm/cold cache and multiple runs. A larger timeout or more concurrency is not proof of improved throughput or coverage.

- [ ] Record before/after median and p95 latency, bytes, query/Redis operations, provider requests, and coverage completeness.
- [ ] Set explicit budgets from the measured baseline. Suggested guardrail: reject an unexplained >10% p95 regression in an unaffected critical journey; this is a proposed threshold, not a current performance claim.
- [ ] Verify optimized and reference calculations return identical fixtures, including billing cycle and expired-pack boundaries.
- [ ] Land each optimization independently of correctness fixes so it can be reverted without losing the fix.

## 6. UX acceptance standard

The critical journey is **connect target → choose review → start once → see truthful progress → understand evidence → approve a fix → retest → optionally share**.

Keep default decisions small. Preselect a single available target; expose advanced focus/revision inputs only when relevant; describe Quick and Standard by actual scope, not an unproven speed guarantee. Retain ownership and approval steps that prevent unintended scanning or changes.

Progress must distinguish waiting, running, finalizing, and accounting uncertainty. Display the target revision and meaningful last update. Avoid simulated percentage completion or a success badge for incomplete evidence. Interrupted work must have a clear recovery action that cannot silently start a second paid scan.

Results should separate actionable findings, verification status, missing evidence, and scope limits. Zero retained findings is not proof of security. Do not conflate a completed execution with an independently verified result.

Keep provider dollar spend private. Customer usage copy must explain the actual minute rounding and multipliers; do not promise per-second cancellation billing when the ledger uses integer-minute ceiling.

Sharing remains deliberate, scoped, and redacted. Verify unpublished/revoked/expired scorecard behavior across the page, OG image, and APIs. Do not introduce long-lived public caching that defeats revocation. External platforms may retain already-fetched previews, so do not promise universal deletion of cached copies.

## 7. Regression matrix

| Area           | Mandatory scenarios                                                           | Release proof                                                   |
| -------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Admission      | double-click, duplicate key, slow/late acceptance, no worker, Redis failure   | One operation/scan; bounded and recoverable response            |
| Webhooks       | duplicate provider event, two failed retries then success, crash, dead-letter | Durable bounded attempts; no duplicate domain effect            |
| Metering       | failed/cancelled/partial/completed, Deep multiplier, replay, contention       | Correct account debit exactly once or explicit unresolved state |
| Evidence       | partial engine output, no findings, missing controls, verified/retest states  | No unsupported security claim; immutable provenance             |
| UI lists       | page two, polling, filters, stale requests, 304, workspace switch             | No skipped/duplicate rows or misleading filter                  |
| Relay          | HEAD/GET/204/304, body limits, TLS, out-of-scope request                      | Faithful allowed traffic and preserved isolation                |
| Public reports | malformed tokens, revoked card, all OG variants                               | Correct PNG/404/privacy behavior                                |
| MCP clients    | package startup, required schemas, OAuth vs stdio, revoked/narrow credentials | Supported capability works; forbidden capability denied         |
| Deployment     | previous payload/image, migration compatibility, worker drain                 | Compatible rollback without destructive DB reversal             |
| Capacity       | sustained queue/Redis use and concurrent accounts                             | Observed resource headroom and latency within agreed budgets    |

## 8. Verification commands and evidence

Product main exposes these scripts at the reviewed revision. Run them from the chosen clean base in a configured disposable development/CI environment, never against production databases by accident. The recovered older root lacks `typecheck:web-tests`; do not silently skip that gate or use its older script inventory as release truth:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm typecheck:web-tests
pnpm typecheck:e2e
pnpm typecheck:browser-harness
pnpm lint:browser-harness
pnpm format:check
pnpm test:core
pnpm test:marketing
pnpm test:motion
pnpm build
pnpm test:e2e
pnpm test:browser-harness
pnpm verify:worker-image
git diff --check
```

Run focused new integration tests using the existing CI PostgreSQL 16 / Redis 7 services and test patterns. `packages/integrations/src/queue.redis.test.ts` is gated by `CI=true`; a local pass with that gate disabled is skipped coverage. Add real webhook/metering boundary cases explicitly to required CI rather than assuming existing mocked tests cover them. Use a non-superuser/non-BYPASSRLS runtime role for tenancy proofs; migration setup may use the separate test owner. Verify service endpoints are disposable before any suite that deletes test Redis keys or database rows.

For schema changes, include Prisma generation, migration drift/forward-compatibility, and runtime-role RLS checks. For worker/release-script changes, run the existing `.github/scripts/tests/` Node and shell suites and pinned-engine/worker contract checks. Follow the engine's checked-in `scripts/verify-controlled-derivative.sh` and CI/toolchain for lint, type checking, sandbox tests, and pinned-worker contract verification rather than inventing a new dependency installer.

For a clean marketplace export, execute its existing validation and Zed build gates in workflow order:

```sh
node scripts/validate.mjs
(cd zed-extension && cargo fmt --check && cargo build --locked --release --target wasm32-wasip2)
node scripts/validate.mjs --release
```

The published-package verifier accesses npm and executes the selected package; run it only in the intended isolated verification environment. Its success is not equivalent to a hosted authenticated scan or production payment proof.

For every gate, record revision, command, environment class, start/end timestamps, exit status, and artifact/log location. Redact secrets, customer payloads, and provider cost internals from public CI artifacts.

## 9. Release, rollback, and readiness

Use focused PRs for Tasks B–H, with baseline tests landed before or together with the corresponding fix. Task B can proceed independently after Task A. Tasks C and E both modify queue authority; sequence their edits/merges or explicitly coordinate them, then rerun combined integration gates. Task H regeneration follows the merged authoritative source/package state. Correctness and security PRs precede optional optimization PRs. Do not merge a giant “remove all technical debt” change.

Test backward compatibility before migrations or producer payload changes. Deploy additive schema support first, compatible readers next, then new writers. For the webhook identity/claim change, coordinate ingress and the retry consumer so an old writer cannot defeat the new claim contract. Old pending records need a tested compatibility path, not deletion.

Promote a canary built from exact reviewed SHAs and immutable image digests. Validate readiness plus authorized critical journeys and compare error/latency/queue/settlement signals with the baseline. Stop rollout on duplicate monetary effects, tenant leakage, lost evidence, invalid terminal states, or unexpected queue growth.

Rollback application/worker images and feature exposure to the known-good compatible versions; retain additive schema and all accounting/evidence records. Do not automatically resume old billing jobs or erase unresolved intents to make dashboards green. A security rollback must not silently reintroduce the known dependency exposure; keep a reviewed patched fallback image or disable only the affected optional surface through a controlled gate.

**Broader production sign-off remains separate:** sustained Redis/capacity evidence, payment-provider settlement/checkout/refund acceptance, operational payout/tax ownership, backup/restore and incident response, and independent evidence/retest quality require their own current proofs. This review does not close those gates merely because the recorded release succeeded.

Definition of done for LS-01–LS-08: each confirmed source defect has a test demonstrating the original failure and a passing correction; real external-system boundary tests run; no required check is bypassed; public contracts and billing/evidence invariants remain intact; each shipped revision has rollback evidence; remaining operational gates are explicitly passed or marked unresolved. Task I remains deferred unless measurements justify it. Passing the existing mocked baseline or editing this plan does not close a defect.

## 10. Source index

Repository references below are pinned to main review revisions. Local divergence in §1.1 is a separate snapshot and must not be conflated with those links. Primary upstream references were consulted for dependency, queue, HTTP, and subprocess contracts; recheck version-sensitive guidance before implementing.

- [Recorded production release](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36612020939)
- [Product operating constraints](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/AGENTS.md)
- [Product scripts](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/package.json)
- [Scan profiles](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/packages/types/src/scan-profile.ts)
- [Queue producer and queue-position code](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/packages/integrations/src/queue.ts)
- [Queue tests](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/packages/integrations/src/queue.test.ts)
- [Webhook retry consumer](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/worker/src/jobs/webhook-track-retry.job.ts)
- [Webhook domain execution](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/packages/billing/src/webhook-tracks.ts)
- [Billing meter](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/packages/billing/src/usage/meter.ts)
- [Scan settlement](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/worker/src/jobs/run-scan/settlement.ts)
- [Scan-list state](<https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/web/src/app/(dashboard)/dashboard/scans/use-scan-list-state.ts>)
- [Active polling](<https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/web/src/app/(dashboard)/dashboard/scans/use-active-scans-polling.ts>)
- [Scan SSR page](<https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/web/src/app/(dashboard)/dashboard/scans/page.tsx>)
- [Web package](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/web/package.json)
- [Resolved dependency lockfile](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/pnpm-lock.yaml)
- [Authoritative dependency overrides](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/pnpm-workspace.yaml)
- [Existing billing retry reconciliation](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/worker/src/jobs/billing-reconciliation.job.ts)
- [Webhook ingress](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/web/src/app/billing/webhook/route.ts)
- [Usage and webhook-track schema](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/packages/db/prisma/schema.prisma)
- [Cloud engine pin](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/.github/workflows/deploy-azure.yml)
- [Desktop engine pin](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/.github/workflows/release-tauri.yml)
- [Score OG route](<https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/web/src/app/(public)/api/og/score/[slug]/route.tsx>)
- [Lite OG route](<https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/web/src/app/(public)/api/og/lite-check/[token]/route.tsx>)
- [Lite token authentication](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/apps/web/src/lib/lite-scorecard.ts)
- [Engine relay](https://github.com/ecryptoguru/lyrashield-engine/blob/827ea1e590856ee7984756ec31041b35cc58ca14/lyrashield/runtime/target_relay_proxy.py)
- [Relay at the product-pinned engine revision](https://github.com/ecryptoguru/lyrashield-engine/blob/c2fb19595bdefa0eda52d09ccd2aaeabcca575ae/lyrashield/runtime/target_relay_proxy.py)
- [Monotonic engine deadline](https://github.com/ecryptoguru/lyrashield-engine/blob/827ea1e590856ee7984756ec31041b35cc58ca14/lyrashield/lifecycle/deadline.py)
- [Reverse consumer pin](https://github.com/ecryptoguru/lyrashield-engine/blob/827ea1e590856ee7984756ec31041b35cc58ca14/.lyrashield-worker-pin)
- [Marketplace source exporter](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/packages/agent-plugin/src/export.ts)
- [Authoritative package verifier](https://github.com/ecryptoguru/lyrashield-ai/blob/9b548984fcecd0a2a5c675800af79ec057a9969a/docs/marketplace/scripts/verify-published-mcp.mjs)
- [Marketplace manifest](https://github.com/ecryptoguru/lyrashield-marketplace/blob/8d3d418a1f8dbfa6f5ab2004e728b7731ddb77f3/manifest.json)
- [Marketplace validator](https://github.com/ecryptoguru/lyrashield-marketplace/blob/8d3d418a1f8dbfa6f5ab2004e728b7731ddb77f3/scripts/validate.mjs)
- [Marketplace release workflow](https://github.com/ecryptoguru/lyrashield-marketplace/blob/8d3d418a1f8dbfa6f5ab2004e728b7731ddb77f3/.github/workflows/release.yml)
- [Marketplace package verifier](https://github.com/ecryptoguru/lyrashield-marketplace/blob/8d3d418a1f8dbfa6f5ab2004e728b7731ddb77f3/scripts/verify-published-mcp.mjs)
- [Codebuff adapter](https://github.com/ecryptoguru/lyrashield-marketplace/blob/8d3d418a1f8dbfa6f5ab2004e728b7731ddb77f3/codebuff/lyrashield-review.ts)
- [Zed adapter](https://github.com/ecryptoguru/lyrashield-marketplace/blob/8d3d418a1f8dbfa6f5ab2004e728b7731ddb77f3/zed-extension/src/lib.rs)
- [BullMQ job identity rules](https://docs.bullmq.io/guide/jobs/job-ids)
- [BullMQ producer/worker connections](https://docs.bullmq.io/guide/connections)
- [Official Next.js advisory](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j)
- [HTTP semantics, Content-Length](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6)
- [Node subprocess semantics](https://nodejs.org/api/child_process.html)
