# Trusted runtime supervisor

`apps/supervisor` is the trusted execution-control service for scan attempts. It is a foundation
for the broker handoff and is not wired into production admission yet.

The supervisor is the only service expected to hold Docker control. It accepts bounded,
attempt-bound `PREPARE`, `START_PAID`, `START_UNMETERED`, `STOP` and `RECONCILE` commands from
an authenticated control caller. Every command intent is fsynced to a signed, monotonic journal
before a container, cgroup, subprocess or provider-grant effect occurs; the planned executor
ownership identity is journaled before any create effect as well. A repeated command id
returns its recorded status and receipt; it never repeats the effect. The journal fails closed
after a write/fsync failure or an integrity rejection and never reuses a sequence.

`STOP` begins provider-grant revocation and attempts to remove every known owned container even
if another teardown or revocation fails. A delayed or missing create/start acknowledgement remains
`UNKNOWN` after removal because a daemon action may still arrive late. A provider request also
keeps settlement uncertain: local token revocation does not prove the provider stopped or charged
nothing. `RECONCILE` preserves those holds until the missing authority evidence exists. Process
execution and process cleanup are held entirely until cgroup ownership and privilege isolation are
qualified; their executor does not inspect or signal an unverified cgroup.

The executor-key vocabulary is stable in `@lyrashield/runtime-control`: `http-prepare`,
`staging`, `relay`, `repository-token`, `checkout`, `sandbox`, `engine`, `resolver`, `scanner`
and `cleanup`.

## Closed default

`LYRASHIELD_RUNTIME_ADMISSION` defaults to `closed`. In that state `/healthz` is available and
new preparation/start commands are rejected; authenticated STOP and RECONCILE remain available
for attempts already present in the journal. The entrypoint rejects `open` even when configured:
the broker, provider settlement and independent-journal boundary have not yet been qualified.

Required runtime configuration:

- `LYRASHIELD_SUPERVISOR_JOURNAL_PATH`
- `LYRASHIELD_SUPERVISOR_SIGNING_SECRET` (at least 32 bytes)
- `LYRASHIELD_SUPERVISOR_CONTROL_TOKEN` (at least 32 bytes)
- `LYRASHIELD_PROVIDER_GATEWAY_URL`
- `LYRASHIELD_PROVIDER_GATEWAY_CONTROL_TOKEN`
- `LYRASHIELD_SUPERVISOR_ALLOWED_IMAGES` (comma-separated exact image references)
- `LYRASHIELD_SUPERVISOR_ALLOWED_NETWORKS` (comma-separated exact Docker networks)
- `LYRASHIELD_SUPERVISOR_ALLOWED_PROCESS_COMMANDS` (comma-separated exact executable paths)
- `LYRASHIELD_SUPERVISOR_ALLOWED_CWD_ROOTS` (JSON string array)
- `LYRASHIELD_SUPERVISOR_CGROUP_ROOT`

The service binds to `127.0.0.1:8790` unless explicitly configured otherwise. Do not expose the
control API directly to a sandbox or the public internet.

## Independent journal adapter and readback

`createSupervisorAuthorityJournal()` supplies a `JournalPort` for `SupervisorService` using two
separate signed local files. The original supervisor record is retained unchanged inside the
independent authority event's payload. The wrapper has its own sequence, predecessor, hash and
signature; the original canonical envelope is never rewritten or re-signed. Its event identity
is derived from the original record hash, so a lost acknowledgement cannot create a new identity.

The factory requires an exact epoch and supervisor identity, protected object-store and PostgreSQL
mirror ports, and an injected `authorize(event, binding)` implementation. That implementation must
atomically compare the persisted epoch, operation, scan, workspace, attempt and authority revision.
An additional mandatory `authorizeStream({ epochId, supervisorInstanceId })` port validates the
persisted active stream before and after readback, including empty genesis reads. Revocation
latches the adapter closed; unavailable authorization stays unresolved.
Every append and read revalidates that authority around local/R2/database readback. A read never
repairs a pending append. Replay requires the same original payload; a missing acknowledgement or
negative read remains unresolved, and conflicting histories latch the adapter closed.
Explicit replay re-fsyncs the exact original file and any recovered pending wrapper, without
changing their envelopes. A local port that cannot confirm an existing record stays unresolved;
ordinary cursor reads perform no such repair.

Authenticated `GET /v1/journal` accepts exactly `epochId`, `supervisorInstanceId`, `afterSequence`,
`afterHash` and `limit`. The predecessor is the original stream's hash (64 zeroes at sequence 0),
and the limit is 1–100. Responses contain independently signed records with the original signed
envelope at `records[i].payload.payload`, a `nextCursor`, and `hasMore`. Pages are capped at 256 KiB;
new original events are capped below 128 KiB so a cursor can make progress. A wrong epoch,
supervisor or predecessor is rejected. The endpoint requires the existing control credential and
returns `no-store` responses.

Cursor reconciliation uses one authenticated original snapshot rather than reloading the entire
original file for each event. A captured snapshot that changes while queued is rejected for retry;
source and independent heads are rechecked around authority validation. The closed prototype
limits cursor history to 64 records, 512 KiB of original bytes and 1 MiB of wrapper bytes, with
bounded file reads before joining STOP/append serialization. Over-limit readback returns
`READ_LIMIT`, proves no recovery, performs no repair, and does not latch the writer. Append,
startup history and STOP keep the complete history available above the cursor ceiling.

For ten records and a one-record page, tests measure three bounded original loads, five bounded
wrapper loads, twenty R2-record reads, twenty database-record reads, ten event-authority calls and
three stream-authority calls. A cold adapter adds one wrapper load and ten record reads per mirror.
The fixed ceiling is a **production blocker**, not a scalable recovery design: authenticated
checkpoints/compaction or genuinely bounded paging are still required. No history is discarded.

The production entrypoint still uses its closed local-only configuration: this endpoint returns
503 there. Replacing that factory requires the real protected storage and persisted authority
implementation, plus an atomic per-action executor/provider fence. Journal confirmation alone
does not authorize creation, start, teardown or provider effects. The adapter's tests of STOP
against delayed intent confirmation do not qualify native Docker delayed-daemon behavior,
cgroup ownership, process isolation, managed-provider durability or production admission.

Service-owned same-operation recovery is an **open P2 integration blocker**. With real signed
files, a lost PREPARE journal acknowledgement followed by an identical command retry one
millisecond later fails `IDENTITY_CONFLICT` because the service regenerates `observedAt`.
Restart initialization fails `REPLAY_REQUIRED` while durability is pending. Explicit trusted
adapter replay of the stored original payload confirms only journal durability; a fresh service
still returns `UNKNOWN`, with no executor/provider effect replay. The service has no authenticated
recovery route that completes this handoff. Keep admission closed until that recovery integration
retains the exact original identity and reconciles effects independently.

## Deployment boundary

The prototype defines immutable container images, bounded argv/environment, network, CPU, memory
and PID limits. Local process execution is held. Host source mounts and the broker's signed attempt
admission are intentionally not fabricated here.
The broker must supply the authority binding and staging mounts, then qualify the exact deployment
topology before admission opens.

Run the focused tests with `pnpm exec vitest run apps/supervisor/src` and the Linux-only fault
harness with `pnpm --filter @lyrashield/supervisor test:linux-faults`. The harness skips with an
explicit message when it is not running on Linux with writable cgroup v2. It is not a substitute
for native Docker delayed-daemon or process-isolation qualification.
