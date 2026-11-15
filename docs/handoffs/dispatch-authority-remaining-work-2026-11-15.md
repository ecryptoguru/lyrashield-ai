# Dispatch authority chain — remaining work (#7)

Status: **not enabled in production.** Production scans run the established
legacy path (`createScan` → BullMQ → worker → engine → sealed result manifest),
and the worker logs `"Worker authority selected"` `mode: "legacy"` at startup.
This document lists what already exists alongside what is missing and what
must be produced before the chain can be opened. It records no new decision: enabling
this remains a founder decision.

Chain under discussion:

```text
durable admission (Postgres) → physical execution (protected host)
→ provider authority (grants + gateway) → authenticated receipts
→ settlement → recovery
```

## Already built (verified in this repository)

| Area                       | State                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database contract          | Migrated and live. `ScanDispatchOperation`, `ScanQueueOutbox`, dispatch lifecycle commands, worker assignment, cleanup invocation fence, supervisor receipt-ingestion and preparation projections, digest functions, policy-binding generation trigger, forced RLS plus dedicated reader roles.        |
| Durable admission          | `persistShadowScanDispatchAdmission` writes the operation, quarantines it to `UNKNOWN`, then writes an `UNKNOWN` outbox row. Reachable only through `dispatchAuthority: "shadow"`, which **no production caller passes** — the only non-test occurrences are the type declaration and the gate itself. |
| Worker authority selection | One immutable startup decision with no env, HTTP or queue selector: installed broker → `broker`, absent → `legacy`, present-but-unverifiable → `closed` with readiness removed.                                                                                                                        |
| Protected host installer   | `ops/controller/install-controller-host.sh <exact-revision>` installs systemd units and five fixed sockets with distinct groups (supervisor, broker, worker, native executor, preparation issuer).                                                                                                     |
| Disposable liveness lane   | Docker-in-Docker, `--network none`, four real images, real migrations, finite RSA pin bound to run, boot, nonce, source tree and image tuple. Its own receipt reports `admission: CLOSED`, journal `UNQUALIFIED`, native effects `UNMEASURED`.                                                         |
| Journal object storage     | Private `lyrashield-runtime-control` R2 bucket, public access disabled, credential `runtime-control-r2-storage` in the qualification Key Vault.                                                                                                                                                        |
| Test mass                  | 39 supervisor suites, 32 runtime-control suites, 12 controller Python suites. All local or synthetic; none is production qualification.                                                                                                                                                                |

## Blockers, each enforced by code today

**1. Supervisor admission cannot open.**
`apps/supervisor/src/config.ts` throws for `LYRASHIELD_RUNTIME_ADMISSION=open`:
_"Supervisor admission is held until broker and journal qualification is
installed"_. This is an unconditional gate, not a missing configuration value.

**2. The authority preflight reports the platform ineligible.**
`apps/supervisor/src/independent-composition.ts` returns
`admission: "closed"`, `productionEligible: false` with the reason
_"Authenticated persisted full-command, scope, revocation and policy authority
is not installed"_. It is read-only by design: it cannot instantiate a
production journal, publish a checkpoint, provision an epoch or return
physical-effect permission.

**3. The journal has a prototype read ceiling.**
`apps/supervisor/src/authority-journal.ts` caps reads at 64 records, 512 KiB of
originals and 1 MiB wrapped, commented _"Closed prototype safeguard …
needs authenticated checkpoints/compaction or truly bounded paging"_. A
production journal exceeds this immediately.

**4. There is no provider settlement protocol.**
`apps/supervisor/src/supervisor-operations.ts` sets `settlementUnresolved` and
throws _"provider settlement is unresolved"_ when a revoked grant had already
issued requests: a revoked local token cannot prove the upstream request
stopped or was free. Broker-mode paid work cannot be safely aborted without
this, so it cannot be authorised.

## Provisioning and release gaps

**5. Four credential artifacts have no producer.**
Outside tests nothing writes, and the installer deliberately refuses to write:

- `/etc/lyrashield/native-executor.env` (root `0400`)
- `/etc/lyrashield/control/worker-authority.json` (root:worker `0440`, schema
  `lyrashield-worker-broker-installation/1`, SHA-256 bound to
  `LYRASHIELD_WORKER_INSTALLATION_CHECKSUM`)
- `/etc/lyrashield/worker-observer.env` (root `0400`, restricted
  `app_native_origin_reader` login)
- `/opt/lyrashield/runtime-control/runtime-qualification-key.json` (the managed
  public pin the host helpers verify)

There is no KMS/Vault custody design, no rotation procedure and no revocation
runbook for these.

**6. No controller image has been published for this release.**
`.github/workflows/publish-controller-images.yml` exists, is manual, requires
an exact merged main SHA and the confirmation phrase, and pins by digest. It
has not been run for the current release, so no immutable broker, supervisor or
provider-gateway image exists to pin.

**7. No cutover or rollback story.**
Nothing defines the move from shadow to authoritative: the outbox transition
`UNKNOWN → PUBLISHED`, the worker lifecycle handover from `legacy` to `broker`,
the drain order, or the revert. Authority is one immutable decision per worker
process, and no document describes a mixed fleet.

**8. No production proof for the four roles.**
The disposable lane proves liveness under a fake nonce pin. Nothing proves the
installed root boundary on the real host.

## Work required, in dependency order

Each item lists what to produce and the evidence that closes it.

1. **Decide scope.** Broker authority is not required for Cloud to scan; it is
   required to claim hosted paid execution under verified physical authority.
   Record the decision before building.
2. **Implement the authenticated authority bundle** — full command, scope,
   revocation and policy, persisted and signed — so
   `inspectSupervisorIndependentComposition` can return
   `productionEligible: true`. _Evidence: preflight output plus tests proving a
   tampered or stale bundle fails closed._
3. **Add journal checkpointing/compaction** (or genuinely bounded paging) to
   remove the 64-record ceiling. _Evidence: sustained append/read above the old
   ceiling with rotation, restart and truncation-tamper tests._
4. **Define and implement provider settlement** — upstream request accounting
   strong enough that revocation can prove stop-or-free. _Evidence: a revoked
   grant with in-flight requests reaches a definitive settlement or an explicit
   unresolved hold, never a silent credit._
5. **Provision the four credential artifacts** through a reviewed, idempotent
   installer path with KMS/Vault custody, rotation and revocation. _Evidence:
   installer readback on the real host, ownership and mode assertions, rotation
   test, and refusal when a secret is absent._
6. **Publish and qualify the four controller images** for the exact release
   with digest pins retained. _Evidence: published digests bound to the merged
   SHA, plus the qualification receipt._
7. **Write the cutover runbook**: stage on the VM, one bounded paid scan in
   broker mode, then drain, then flip, then a tested rollback to legacy. _Evidence: a
   completed broker-mode paid scan with receipts, then a rollback exercised and
   observed._
8. **Record qualification** in `PRD.md` §8 and `codebase.md` §11 before any
   public claim.

## Rough effort

Items 2–4 are protocol engineering and are the reason this was gated; treat
them as the bulk of the work. Items 5–7 are operational plumbing that becomes
mechanical once the protocol exists. Item 1 is a decision, not an
implementation.

## Non-goals

Enabling this must not change the legacy path, must not weaken egress, signing
or isolation, and must not enable shadow admission ahead of the other items:
`UNKNOWN` rows nothing can legally consume are worse than no rows.

## Related reading

- [`ops/controller/README.md`](../../ops/controller/README.md) — host install,
  socket groups, worker authority schema.
- [`codebase.md` §11](../../codebase.md) — production topology and accepted
  evidence.
- [`PRD.md` §8](../../PRD.md) — current release evidence and holds.
