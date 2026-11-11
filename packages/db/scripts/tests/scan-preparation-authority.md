# Closed checked preparation intent

`20261111130000_scan_preparation_authority_fence` adds a disabled production
prototype. The worker still cannot call PREPARE. A server-created broker may
select `preparationAuthority: "checked-intent-v1"` only for isolated contract
qualification. The default broker rejects new preparation. Neither installation
can execute a checked attempt: SQL rejects START rows, PREPARE status consumption,
and physical transitions toward preparation or execution. Historical attempts
remain visible to status, STOP and reconcile; the tests seed them before the new
migration, without backfill or a production legacy-insert exception.

The attempt records nullable `authorityAcceptedAt`, `authorityDeadlineAt` and
`authorityTransactionId`. Legacy values are all NULL. Every new attempt derives
all three in SQL, rejects caller values, and seals its RESERVED physical row,
PENDING PREPARE and PREPARING operation in the original transaction. Existing
immutable identity triggers retain the fields. The transaction ID is audit data,
never a capability. Replay validates current authority and the original live
fields; it never replaces or refreshes them.

Preparation uses the existing broker lock order, then a nonblocking exclusive
transaction advisory gate. Source DML on Workspace, WorkspaceMember, users,
BillingAccount, agent connections/operations/provenance, Target, Policy, Scan,
UserScanSlot, ScanCapacityReservation, ScanAuthorityEpoch and ScanWorkerInstanceGrant
takes the shared gate before row DML.
A transaction already holding the exclusive gate cannot mutate these sources,
even after `SET CONSTRAINTS ALL IMMEDIATE`. Gate acquisition and validation are
separate same-client READ COMMITTED statements; other isolation levels fail
closed. Privileged maintenance must separately drain. Runtime TRUNCATE, DDL,
trigger bypass, effective writer/consumer privileges and reachable unreviewed
security definers are incompatible; no production preparation grants are added.
Preparation requires a direct restricted login; SET ROLE cannot hide the
authenticated session privilege boundary. The sole new definer returns only persisted operation workspace/account/user
context and is unavailable to application roles.

This scope accepts accounting-v2 repository REVIEW_TARGET/SNAPSHOT and
REVIEW_CHANGES/DIFF plans with exact immutable revisions and a positively
published queue identity. It rejects authenticated assessments, attachments,
optional request/response limits, capabilities beyond 64 UTF-8 bytes and budgets
beyond four decimal places.
The SQL full-plan digest has executable canonical-JSON/hash parity fixtures for
UTF-8, escapes, arrays, nulls, nested ordering and bounded numbers. Source revision
mutation with an unchanged hash is rejected through direct SQL too.

The checker uses persisted active membership and canonical operational-role
parity, creator/account ownership, active Agency sponsorship, account billing
ranking, controlling trial/paid expiry, policy/profile ceilings, and current
connection scopes, target/profile/workflow, expiry/version and immutable outer
operation provenance. Accounting-v2 capacity remains the admitted RESERVED
funding record. This prototype does not establish full balance/funding projection,
annual allowance, complimentary entitlement or provider qualification parity.
Those authorities and physical consumption revalidation remain activation gates.
Delegated membership predicates reject NULL arrays and NULL elements, including
mixed valid/NULL arrays. Stored allowed profiles use canonical uppercase
normalization before comparison.

Acceptance and controlling deadlines use a captured database UTC wall clock,
floored to milliseconds. Deadline is at most ten seconds, attempt/grant expiry,
and any controlling subscription, FREE trial or delegation expiry. An expired
historical trial does not truncate active paid entitlement. This is checked-intent
validity, not authorization at COMMIT or physical action. WAL/replication delay
cannot be proved by a timestamp trigger. Lost COMMIT acknowledgement or an
acknowledgement or final caller continuation observed after the conservatively
mapped monotonic deadline returns transport UNKNOWN while retaining
actual durable history, which can still be PREPARING. Status exposes preparation
eligibility separately, and expired intent remains stoppable/reconcilable.
The same deadline bounds COMMIT and post-COMMIT liveness readback; stalled clients
are destroyed. A final synchronous elapsed check follows transaction finalizers
and the broker caller continuation. Local wall clock is not an authority source.

Future supervisor integration must persist and authenticate the exact canonical
SupervisorCommand, executor specification, policy and grant commitment before a
physical effect. The existing type/operation/attempt `commandDigest` does not
provide that commitment. No queue replay, legacy paid fallback or production
cutover is authorized by these fixtures.

Run `bash packages/db/scripts/tests/scan-dispatch-authority-pg.sh` for the isolated
restricted-role PostgreSQL/Redis suite, staged historical migration compatibility,
COMMIT fault relay, concurrency and schema parity checks. The runner accepts no
external database URL and owns only its disposable local fixtures.
Epoch closure tests run in a separate cloned test database after the shared suite
has ended. The migration now installs 14 functions and 21 triggers; restore
qualification must verify this additive catalog and its exact bodies/ACLs, rather
than infer coverage from the original dispatch-authority allowlist.
