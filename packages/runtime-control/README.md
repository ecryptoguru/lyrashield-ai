# Runtime control implementation status

These interfaces and local fixtures are development work. Supervisor and
provider-gateway entrypoints reject open admission. No production execution or
release qualification follows from passing the tests here.

The independent journal compares signed local intent, conditional object-store
records, and PostgreSQL mirror records. A missing or conflicting durability
observation prevents execution permission. A lost acknowledgement requires
readback and replay of the same operation identity; a negative read does not
prove that the earlier write failed. Authorization is checked around durability
work, but each physical effect still requires broker and supervisor fencing.
Recovered pending local records require explicit `JournalPort.confirmRecord()` fsync confirmation
before same-identity replay can advance independent storage. `SignedJournal` confirms the exact
owned file and directory without changing the record. Ports without that capability stay
unresolved. Read-only confirmed-history calls never perform this repair.

## PostgreSQL mirror

`PostgresAuthorityMirror` uses a separately credentialed, caller-owned pool.
Each operation checks out an idle connection and completes its own transaction.
Append inserts immutable record bytes and advances only the exact predecessor
head while locking the stream row. Exact same-head/same-record replay is safe;
stale or foreign records cannot overwrite a newer head. Raw canonical text is
retained instead of regenerating bytes from JSONB.

Each request has a ten-second client deadline, including connection acquisition
and commit. Backend statement and lock timeouts add protection. A timeout or
lost commit reply destroys the connection and reports an unavailable outcome;
it never converts that uncertainty into a failed write or a new operation ID.
Local synchronous WAL completion does not prove managed PostgreSQL failover
durability.

`sql/authority-mirror.sql` is an install-once schema for the separate trusted
authority database. It is **not** a product Prisma migration or a runtime
bootstrap. Install under a dedicated non-login owner with no superuser,
role-creation, database-creation, or RLS-bypass privileges. Remove its temporary
database CREATE privilege after installation. The trusted mirror role receives
schema USAGE and EXECUTE on the three functions only; application workers
receive neither. No runtime role receives direct table privileges or membership
in the owner role. The functions use a fixed `pg_catalog` search path and fully
qualified tables.

Epoch/stream provisioning is intentionally absent. A missing or inactive stream
fails closed. Provisioning a new epoch must follow independent reconciliation
and signed runtime-record issuance. This adapter cannot establish that
qualification, reopen a restored baseline, or repair disagreement by rewriting
another journal.

Run the network-isolated, local-image PostgreSQL fixture with:

```sh
bash packages/runtime-control/scripts/postgres-mirror-test.sh
```

It owns and identity-checks its temporary Docker container, requires a local
Unix-socket Docker context, and accepts no database URL. It tests restricted
roles, concurrent append, same-identity replay after a simulated lost commit
reply, transaction rollback, exact bytes and signed-journal rejection after a
simulated database rollback. Its conditional object store remains a fixture.

## Remaining release gates

Actual R2 conditional-write and credential-isolation qualification, managed
database failover, broker/outbox wiring, epoch fencing at physical execution,
exclusive process isolation, provider settlement, protected attestation issuance,
native image tests, coherent rollout/rollback and production acceptance remain
open. Do not remove admission or release holds based on this local harness.
