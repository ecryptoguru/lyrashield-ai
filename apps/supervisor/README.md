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
