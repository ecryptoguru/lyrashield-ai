# ADR: closed durable scan-dispatch authority foundation

**Status:** implemented and closed, not admitted. This ADR records the corrective schema (`packages/db/prisma/migrations/20261105130000_durable_dispatch_authority`), the broker transaction layer (`packages/db/src/scan-dispatch-authority-broker.ts`) and the disposable-PostgreSQL fixture (`packages/db/scripts/tests/scan-dispatch-authority-pg.sh`). It amends the design direction in `2026-11-04-dispatch-authority-boundary.md`. Nothing here deploys, opens an epoch, changes a production role, or grants runtime consumers access to authority tables. Production admission stays held.

## Decision

Keep scan-admission authority durable, closed and broker-owned:

1. **Queue publication is transport, not authority.** BullMQ publication moves to `ScanQueueOutbox` (scan-keyed, no attempt foreign key). `QUEUE_PUBLISH` is removed from `ScanDispatchCommandType`; supervisor commands are only `PREPARE`, `START_PAID`, `START_UNMETERED`, `STOP`, `RECONCILE`.
2. **One durable operation per scan.** `ScanDispatchOperation` is created at admission, keyed by scan ID with a `requestDigest` of the admitted scope, and is the authoritative lookup for lost-ACK recovery. The worker-bound `ScanDispatchAttempt` is created later by the broker and only while its operation is `QUEUED`, `WAITING_CAPACITY` or `PREPARING`.
3. **Every state change is receipt-bound.** The supervisor journal is mirrored into `ScanSupervisorReceipt` (monotonic per-instance sequence, hash-chained, signed, bound to its outbox command). Physical transitions, outbox acceptance/completion and terminal release receipts all require authenticated supervisor evidence; free-text evidence references are removed.
4. **UNKNOWN is sticky.** A lost COMMIT response, a dead supervisor mid-command, or a journal/database disagreement leaves the operation and its physical execution in `UNKNOWN` until an accepted `RECONCILE` command resolves it. Terminal release is rejected while any command for the operation is unresolved.
5. **Capacity is not released here.** The broker mutates the reservation only `RESERVED → RUNNING` at the paid-start boundary. `ScanDispatchReleaseReceipt` records terminal evidence with a `capacityDisposition` (`RELEASED`, `SETTLED`, `REVIEW_REQUIRED`); wiring it into slot deletion or reservation reuse is future integration work that must require the receipt. The paid-start transaction's full write set is: `Scan.status='RUNNING'` (+`startedAt`/`updatedAt`), reservation `RESERVED→RUNNING`, one `ScanEvent` (`billable_boundary`, `retryPolicy=fresh_scan_required`), `ScanDispatchStart`, `ScanDispatchOutbox(START_PAID)`, and operation `→START_PENDING`; prepare writes attempt + physical hold + `PREPARE` outbox + operation state, stop writes `STOP` outbox + `STOPPING`, reconcile writes `RECONCILE` outbox only. The broker identity holds no more than the `leasePrismaUnit` grant list in the broker header comment; proving least-privilege against the real admission identity stays an admission gate.

## Topology and roles

- **Migration owner** (superuser in the fixture; the deployment identity in production): owns schema and grant changes. Not a runtime identity.
- **Broker:** the only writer of authority tables, through the typed transaction layer. It holds the connection until COMMIT, sets its own `synchronous_commit = remote_apply`, and treats a missing COMMIT acknowledgement as `COMMIT_OUTCOME_UNKNOWN`, never as failure or success.
- **Supervisor:** produces receipts behind its own signed journal; the broker mirrors verified receipts. The supervisor itself has no authority-table write path here.
- **Application/worker runtime roles** (`app_runtime_prod`, `app_system_prod`, `app_runtime_ci`, fixture `dispatch_authority_runtime`): the migration revokes all privileges on the eleven authority tables from `PUBLIC` and from these roles; `FORCE ROW LEVEL SECURITY` applies. The disposable fixture proves `SELECT/INSERT/UPDATE/DELETE` are all denied and a direct insert raises `42501`.

## Lock order

Fixed order, in effect in every broker transaction: authority epoch (`FOR SHARE`) → user advisory → workspace advisory (raw `hashtextextended(workspaceId, 0)`, the dominant product key; the prefixed `scan-admission:` variant is not taken — see broker header) → target advisory (`hashtext(targetId)`, matching the scan-creation path) → sponsor account advisory → scan row (`FOR UPDATE`) → operation row (`FOR UPDATE`) → attempt/physical/outbox rows (`FOR UPDATE`). It re-reads all protected state after the scan-row lock, rejects isolation drift, and fails closed on lock timeout. This matches the existing product ordering (user → workspace → account → scan) and extends it; no second, diverging order exists in this layer.

## State machines

- **Operation:** `QUEUED → WAITING_CAPACITY → PREPARING → PREPARED → START_PENDING → ACTIVE → STOPPING → TERMINATED`, with `REJECTED` from pre-start states and `UNKNOWN` enterable from any non-terminal state. `UNKNOWN` exits only to `TERMINATED`; terminal states require a reason. Identity fields are immutable; history cannot be deleted.
- **Queue outbox:** `PENDING → LEASED → PUBLISHED`, with `UNKNOWN → PUBLISHED` after verification only.
- **Supervisor command outbox:** `PENDING → LEASED → DELIVERED → ACCEPTED → COMPLETED|REJECTED`, with `UNKNOWN` enterable at any point; `UNKNOWN` exits to `COMPLETED|REJECTED` only after an accepted `RECONCILE`. Acceptance onward requires a matching non-UNKNOWN supervisor receipt.
- **Physical execution:** `RESERVED → PREPARING → DISPATCH_PENDING → ACTIVE → STOP_REQUESTED → CLEANUP_PENDING → STOPPED`, plus `UNKNOWN` and `NEVER_DISPATCHED` terminals. Each transition must cite exactly one supervisor receipt whose type and command match the transition. Leaving `UNKNOWN` requires a completed `RECONCILE`, and `STOPPED`/`NEVER_DISPATCHED` require every command of the operation to be resolved.
- **Capacity:** the broker only advances `RESERVED → RUNNING`; the unresolved-attempt quarantine key keeps one unresolved physical attempt per scan.

## Recovery and failover rules

- Lost COMMIT: the caller re-queries by the same `operationId`; `status()` returns the durable state or `STATUS_UNAVAILABLE`. Replay of `prepare`/`startPaid`/`stop` returns the already-committed identities for the same operation; replay with changed worker, grant or epoch identity raises `DISPATCH_REPLAY_CONFLICT`. A replay can never mint a second attempt, a second paid start, or a second STOP.
- Lost ACK is symmetric for the supervisor: redelivery of a command is status, not a second execution, and the supervisor receipts table rejects non-contiguous or mis-linked journal entries.
- Failover/epoch loss: authority epoch `1` (`scan-authority-baseline`) is created closed and cannot be reopened; an old epoch cannot be revived after a restore. Attempt insertion requires an open epoch and a live worker grant covering the whole attempt window in that epoch. A database/supervisor journal disagreement fails closed to `UNKNOWN` and stays quarantined.
- Deletion and scope change: a soft-deleted scan blocks operation creation; a deleted target or any change to the admitted plan, policy, sponsor, attachments, delegation version or capacity identity invalidates the stored digest and fails `prepare` with `DISPATCH_SCOPE_CHANGED` instead of silently upgrading authority.

## Rollback

Forward-only. Rolling back must not delete attempts, receipts, epochs or holds (every authority table rejects `DELETE`); a rollback target that does not understand these tables must leave admission closed. This ADR does not authorize production application of the migration; before deployment the grant block executes only if the corresponding roles exist.

## Verification boundaries

The disposable fixture proves, on real schema and real PostgreSQL 17: migrate-deploy parity (zero Prisma drift), atomic prepare/paid-start/stop/reconcile transactions, concurrent-prepare serialization, revoked/expired-grant and closed-epoch rejection, replay conflict detection, scope-change and target-deletion invalidation, single terminal release with duplicate-release rejection, runtime-role denial, lock-contention fail-closed atomicity, and lost-COMMIT recovery through an intentionally dropped COMMIT response. It does not prove managed-service failover, real supervisor signatures, or production role membership; those remain gates of the supervisor/provider task and hosted qualification.
