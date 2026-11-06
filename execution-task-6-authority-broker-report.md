# Execution task 6 — durable dispatch authority broker report

**Status:** COMPLETE (closed authority; not admitted, not deployed, not pushed)
**Worktree:** `/Users/defiankit/.codex/worktrees/durable-dispatch-authority/lyrashield-ai`
**Branch/base:** `codex/durable-dispatch-authority` on `1d55bcff3`
**ADR:** `docs/design/2026-11-06-durable-dispatch-authority-adr.md`

## Commits

- `4be22fea4` fix(db): close the corrective dispatch authority schema — 5 authority tables (`ScanDispatchOperation`, `ScanQueueOutbox`, `ScanDispatchStart`, `ScanSupervisorReceipt`, `ScanDispatchReleaseReceipt`), `PREPARING` physical state, receipt-bound transitions, sticky `UNKNOWN`, terminal release guards, attempt binding to live scan/workspace/user/sponsor/target/plan/slot/reservation/policy/attachment/delegation rows, runtime-role lockdown. Also repairs a millisecond-precision flake in the worker-grant revocation guard (`revokedAt > clock_timestamp()` on a `TIMESTAMP(3)` column now uses a 1 ms tolerance).
- `d741dc081` fix(ci): deny the CI runtime role every authority table — repairs the dangling `-c` (broken psql invocation) in the committed deny step, extends grant exclusions and the privilege deny-check to all 11 authority tables, and excludes them from the runtime SELECT smoke enumeration.
- `7df7ddc98` feat(db): add the dispatch authority broker transaction layer — `prepare`/`startPaid`/`stop`/`reconcile`/`status` with the fixed lock order (epoch → user → workspace → target → sponsor → scan → operation → attempt/physical/outbox), ambiguous COMMIT → `COMMIT_OUTCOME_UNKNOWN`, replay-safe identity reconciliation; reworked fixture harness plus a fault-injecting COMMIT-drop relay.
- `f6aec15a0` docs: record the durable dispatch authority ADR — topology, roles, lock order, state machines, recovery and rollback.

## Test results (all on final head `f6aec15a0`)

- Repo typecheck (`pnpm typecheck`, turbo): 36/36 tasks OK.
- Static schema tests (`vitest run packages/db/src/scan-dispatch-authority-schema.test.ts`): 9/9 passed.
- Disposable PostgreSQL fixture (`bash packages/db/scripts/tests/scan-dispatch-authority-pg.sh`, network-none container, exit 0, run twice): `prisma migrate deploy` clean; `prisma migrate diff --exit-code --from-migrations --to-schema` proves ZERO schema drift on the amended migration; 16/16 broker tests passed with no unhandled errors.
- ESLint (`--max-warnings 0`) and Prettier clean on every touched file; `ci.yml` re-validated as YAML.

Disposable-PG coverage vs the brief: atomic prepare and paid start (one unit or nothing), concurrent-prepare races serialize to one attempt/command, revoked grant and not-yet-covered attempt window rejected, closed baseline epoch rejected, replay with changed worker authority rejected (`DISPATCH_REPLAY_CONFLICT`), execution-plan change and target deletion rejected (`DISPATCH_SCOPE_CHANGED`), one terminal release receipt then duplicate rejected (`23505`), runtime role denied SELECT/INSERT/UPDATE/DELETE on all 11 authority tables (direct INSERT → `42501`), lock contention fails closed with zero partial state, and a real dropped COMMIT response returns `UNKNOWN` and converges on status + replay.

## Remaining supervisor-integration work (deliberately out of scope)

1. `apps/supervisor` service producing signed journal receipts and the HTTP broker authentication of supervisor instances; signature scheme currently stored unverified (length-bounded text) pending the supervisor contract.
2. `START_UNMETERED` broker path (schema enforces zero-funding shape already); deterministic-only/retest admission still needs broker entry.
3. `ScanDispatchReleaseReceipt` consumers: capacity release (slot deletion / reservation reuse) is intentionally not wired; integration must require the terminal receipt.
4. Production epoch opening, production role reconciliation and any migration apply remain gated; this change deploys nothing.
5. The disposable fixture is not wired into CI (CI covers the runtime-role denial via SQL); wiring it is a release-automation decision.
6. Managed failover/restore drills and a deliberately stale REPEATABLE READ snapshot reproduction remain design-doc gates; the broker instead enforces READ COMMITTED and post-lock re-reads, proven fail-closed under lock contention here.

## Risks and notes

- The migration was amended in place, permitted because `20261105130000_durable_dispatch_authority` was never merged, deployed or applied; any environment that did apply the earlier revision must reset it first (none known; the amended migration is provably drift-free against the schema).
- pg pool/client error listeners intentionally swallow dropped-idle/terminated-connection events; every transaction result still surfaces through the typed broker result.
- `SET LOCAL synchronous_commit='remote_apply'` holds only inside the fixture; production durability/failover configuration must be proven separately before admission.
- If new workspace/account-scoped authority tables are added, the `ci.yml` grant/smoke exclusions and the fixture grant exclusion in `scan-dispatch-authority-pg.sh` must be extended in the same change.

## Blockers

None.
