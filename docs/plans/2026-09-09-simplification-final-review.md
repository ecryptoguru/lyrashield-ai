# Simplification waves: final review — 2026-09-09

## Verdict and verified state

**The three waves are not fully complete.** Several reported limitations are unfinished engineering requirements, and the final pass found correctness and authorization defects that existing tests miss.

Reviewed local HEAD `66079cd8027e3aabfa8c1628b04b0c493b8ad094`. Its tracked tree is identical to origin/main `5fa62d5a6b377ca1491e2ef336a3391d8a760767`.

- PRs #637, #638 and #640 are merged.
- #640's applicable PR-head checks passed: [CI 34338091879](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/34338091879).
- Current merged-main checks passed: [CI 34338788447](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/34338788447).
- Earlier main `efccfc3a` has successful production-release and readiness workflow receipts, runs `34337874936` and `34337910801`. The broad statement that nothing was deployed is stale. This does not prove #640 deployment or client acceptance.
- Fresh local core verification: **3,563 passed, 46 skipped, zero failed**; 406 files passed, 6 skipped. Log: `/tmp/lyrashield-final-pass-core.log`.
- Four additional mocked route probes reproduced unsafe behavior. All four passed by asserting the defects; these are counterexample receipts, not passing safety regressions. Log: `/tmp/lyrashield-final-review-probes.log`.
- Browser, visual, marketing and local database counts from the supplied report were not rerun this turn. PR-head CI independently includes the RLS runtime job.
- No paid scan, payment, external mutation, desktop lifecycle test or production deployment was performed during this review. Application source remains unchanged.

## Confirmed findings

### R1 — P1: failed operation retries can create another scan

**Location:** `apps/web/src/app/api/scans/route.ts:126-141`, completion logic at line 363.

The route handles CONFLICT, REPLAY and IN_PROGRESS but lets FAILED fall through to createScan/enqueueScanJob. A retry after a queue failure can create another scan; it never completes the old operation because completion is restricted to NEW. Ambiguous queue acceptance can therefore lead to replaying paid work.

**Reproduced:** a FAILED claim produced HTTP 201, one createScan and enqueue call, and no completeAgentOperation call.

**Fix:** execute only NEW. Return stable outcomes for every other state, retain the original scan reference, and reconcile ambiguous enqueue outcomes without creating more work. Test queue acceptance followed by response loss and concurrent FAILED retries.

### R2 — P1: replay bypasses scope checks and uses the wrong OAuth principal

**Location:** `apps/web/src/app/api/scans/route.ts:118-151`.

Replay returns before target lookup and assertOAuthDelegatedScope. OAuth requests use userId because the route never supplies session.oauth.connectionId; different OAuth connections and a browser session owned by the same user share an operation namespace. Workspace permission is checked, but current target/profile authorization is not rechecked before replay.

**Reproduced:** a scope validator configured to reject the request was never called; replay returned HTTP 200 and the old scan reference.

**Fix:** bind the actual authenticated principal, including OAuth connection and authorization version. Validate current target existence and applicable scope before execution and replay. Test two connections belonging to the same user, reduced grants, deleted targets and browser/OAuth isolation.

### R3 — P1: migration breaks old application writes during rollout or rollback

**Location:** `packages/db/prisma/migrations/20260909120000_agent_operation_principal/migration.sql:26-28`.

principalId becomes NOT NULL without a default or compatibility trigger. Existing rows are backfilled, but the old application writes connectionId without principalId. Those inserts fail after migration, even though the migration claims backward compatibility. Keeping the old unique index does not solve this.

**Fix:** add a forward-only compatibility migration that fills valid legacy connection-backed principal identity and enforces invariants. Verify actual old- and new-client writes against the migrated database. Do not rewrite applied migration history.

### R4 — P2: validation failures leave operations permanently executing

**Location:** `apps/web/src/app/api/scans/route.ts:118-151`; subsequent preflight early returns have the same problem.

The operation is claimed before target, policy, entitlement, rate, concurrency and worker checks. Most rejection paths neither fail nor complete it. Identical retries then return IN_PROGRESS indefinitely despite no submitted scan.

**Reproduced:** a NEW claim followed by missing target returned 404 without failAgentOperation or completeAgentOperation.

**Fix:** perform side-effect-free validation before claiming where possible; record terminal pre-submission rejection separately from uncertain post-submission failure. Return the operation ID and truthful recovery for every claimed path. Test each early return.

### R5 — P2: changing policy does not change retry identity

**Location:** `apps/web/src/app/api/scans/route.ts:122`.

The input hash includes targetId, goal and mode but omits policyId. Same key with a different policy can replay the original result instead of conflicting.

**Reproduced:** two requests differing only in policyId supplied identical operation inputs.

**Fix:** bind all decision-relevant fields, including resolved policy identity, with defined default and canonical-mode semantics. Test changed policy, default policy and equivalent mode aliases.

### R6 — P2: status lookup does not enforce its claimed principal isolation

**Location:** `apps/web/src/app/api/agent-operations/[id]/route.ts:24-25`; `packages/db/src/agent-operation-service.ts:getAgentOperation/getOperationStatus`.

The route discards the authenticated session and queries by operation ID and workspace only. A principal with agent.view can retrieve another principal's operation/result reference within that workspace if it knows the ID. This violates the handoff's explicit no-cross-principal operation-result contract. Option 3's operational permissions do not implement that isolation.

**Fix:** bind operation polling to the authenticated principal and current applicable scope. If workspace-wide activity is intentionally visible, use a separate allowlisted summary contract. Add handler authorization tests: the current route.test.ts tests only the pure state mapper.

### R7 — P2: revoked or expired connections can be labelled usable

**Location:** `apps/web/src/app/(dashboard)/dashboard/connections/page.tsx:84-99`.

Usability depends only on scope strings. A revoked or paused connection with write scope still says “usable for reads and writes.” Expiry does not change the badge. Empty scopes produce both “No scopes granted” and “usable for reads.” The page also lacks the promised reconnect/disconnect actions and last-successful-operation timestamp.

**Fix:** derive effective usability from current connection status, expiry, permissions and scope. Add recovery controls and test active, paused, revoked, expired, empty-scope and read-only states with an injected clock.

### R8 — P2: concurrent report creation can still duplicate snapshots

**Location:** `packages/db/src/report-service.ts:213-228`.

The findFirst/create sequence is not atomic. Two callers can both observe no report and create separate snapshots. Sequential reuse tests do not establish single-winner concurrency.

**Fix:** enforce the intended snapshot identity with database uniqueness or serialization using existing RLS patterns. Account for historical duplicates and soft deletion. Test concurrency against the restricted database role.

## Completion-accounting corrections

The supplied summary omits additional gaps recorded in the ledger:

- **W2-05:** OAuth return state does not survive the GitHub-install round trip.
- **W2-06:** multi-tab, revoked-install and stale-response recovery remains partial.
- **W2-07:** last-successful per-target review-choice memory remains pending.
- **W2-09:** health/recovery is incomplete beyond the missing timestamp; see R7.
- **W3-01:** retest/fix/report REST idempotency remains unwired. CLI/SDK do not supply the new scan Idempotency-Key contract. The scan-idempotency test tests principal selection, not the route's retry semantics.
- **W3-02:** secondary action-menu wiring remains pending.
- **W3-05:** snapshot concurrency remains incomplete.
- **W3-08:** CLI/MCP do not consume the shared status contract. Scan creation returns a full scan record while replay returns only scanId/replayed; operation identity is not consistently returned. Pure mapping tests do not prove cross-surface parity.

The task ledger still marks PR-head CI pending throughout and retains obsolete blocked/deleted-document text. Correct per-task states rather than marking every row complete. Native WebMCP availability and installed-client lifecycle acceptance remain separate live gates; server tests cannot replace them.

## Remediation order and reproduction

1. Repair retry state handling, principal/scope binding and migration compatibility.
2. Convert the counterexamples into expected-safe regressions; add real DB concurrency and old/new writer compatibility tests.
3. Finish shared operation identity/status, connection recovery and the remaining onboarding/UI items.
4. Reconcile the ledger with exact PR, merged-main, deployment and client receipts.
5. Repeat exact-head CI and separately scoped release/client acceptance.

Retained probe: `/tmp/lyrashield-simplification-final-review-probe.test.ts`. Copy it into `apps/web/src/app/api/scans/final-review-probe.test.ts` in an isolated checkout of the reviewed tree, then run:

```sh
pnpm exec vitest run apps/web/src/app/api/scans/final-review-probe.test.ts --maxWorkers=1
```

The probes reuse existing route-test mocks and perform no real scans. They currently assert four defects; invert the assertions to require safe behavior during remediation. The temporary source test was removed after this review.
