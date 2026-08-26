# Untrusted-launch operational gates

Run these checks after a worker, queue, evidence-storage, billing, or license-signing change.
They are release evidence, not a claim of universal coverage.

## Ownership and first response

`lyrashield-operator-alerts` owns first notification. Its receiver acknowledges the
alert, records the revision and time window, and stops paid scan admission if scan
readiness, queue state, or evidence persistence is uncertain. Never replay a scan
whose provider boundary might have been crossed; create a new scan ID only after
the customer or operator explicitly retries.

## Evidence storage

Run from the worker VM in a disposable container using the promoted image. Do not
use `docker exec` against the service container: an exec lifecycle can stop the
attached systemd service and create an avoidable worker handoff.

```sh
set -eu
. /etc/lyrashield/worker-runtime.conf

set --
while read -r host address port extra; do
  [ -n "$host" ] || continue
  set -- "$@" --add-host "${host}:${address}"
done </run/lyrashield-egress-hosts

cleanup() { docker rm -f lyrashield-evidence-proof >/dev/null 2>&1 || true; }
trap cleanup EXIT

common_env="--env NODE_ENV=production --env LYRASHIELD_LOCAL_EVIDENCE_STORAGE=0 --env PLATFORM_ADMIN_EMAILS=ecryptoguru@gmail.com,ankit@lyrashieldai.com --env LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0"

docker run --rm --name lyrashield-evidence-proof --network bridge "$@" \
  --env-file /etc/lyrashield/worker.env $common_env \
  --entrypoint ./apps/worker/node_modules/.bin/tsx \
  "$LYRASHIELD_WORKER_IMAGE" \
  apps/worker/src/operations/verify-evidence-storage.ts

docker run --rm --name lyrashield-evidence-proof --network none \
  --env-file /etc/lyrashield/worker.env $common_env \
  --entrypoint ./apps/worker/node_modules/.bin/tsx \
  "$LYRASHIELD_WORKER_IMAGE" \
  apps/worker/src/operations/verify-evidence-storage-fail-closed.ts
```

Both commands must print their respective `*_OK` marker. The first writes a unique
non-sensitive artifact, verifies ciphertext, authenticated round-trip, unauthenticated
denial, and cleanup. The second has no storage side effect and proves a missing KEK
blocks configuration.

Cloudflare R2 may express a missing authorization header as HTTP 400 with the
exact S3 XML pair `InvalidArgument` / `Authorization`; the proof accepts only
that explicit denial, HTTP 401, or HTTP 403. Other 400 responses remain failures.

## Worker and queue

The scheduled `Production scan readiness` workflow probes `/api/ready/scans` every
five minutes. A non-200 result fails the workflow and emits an app `5xx`, which is
routed by the existing one-minute `app-any-5xx` Azure Monitor alert.

An intentional single-worker egress drain can also produce this readiness failure if a
job claims after the active-job preflight. It remains a real new-admission outage and
must be acknowledged and recovered; it is not evidence that the in-flight paid scan
failed. Preserve the old/new firewall union, let that scan reach a terminal state, and
never cancel, replay, or edit it merely to clear readiness. Require the exact replacement
worker, queue/cost reconciliation, and readiness `200` before closing the gate.

Before a controlled worker restart or failure injection, name the incident commander,
record the founder go decision, enabled schedules, non-terminal scans, BullMQ
waiting/delayed/prioritized/active counts, and terminal provider-cost uncertainty. Do not
continue while unexpected work or unreconciled terminal provider cost exists. After recovery, require all of:

1. `/api/ready/scans` returns worker `true`.
2. Worker image is healthy and its lease has refreshed.
3. Queue/database counts match their pre-test state.
4. No unexpected `engine_start` event occurred.
5. A synthetic stale scan becomes `FAILED` with `QUEUE_ORPHANED`; it is never requeued.

Use the queue reconciliation code path and its normal `updateScanStatus` lifecycle.
Do not delete BullMQ keys or alter a scan row directly to simulate this condition.

After admission is stopped, schedules are disabled, the worker is stopped, alerts have
fired and been acknowledged, and the recorded database/queue counts are zero, run the
disposable orphan fixture from the reviewed production checkout on the worker VM host:

```sh
NODE_ENV=production pnpm --filter @lyrashield/worker exec node \
  --env-file=/etc/lyrashield/worker.env \
  --import tsx src/operations/verify-queue-orphan-fixture.ts -- \
  --environment production \
  --incident-commander "<full name>" \
  --confirm-production "I AUTHORIZE LYRASHIELD QUEUE ORPHAN FIXTURE"
```

The command reads `systemd` and Docker state directly and fails unless both the worker
service is inactive and the `ExecStopPost`-removed worker container is absent. Immediately
before Docker stops the container, systemd writes
`/run/lyrashield/worker-stop-provenance.json` through the root-only capture helper. The
command accepts only a fresh root-owned `0600` regular-file receipt, binds it to the stopped
runtime's product, worker-image, engine revision, and connection-value digests, and refuses
to continue unless the host process's database, privileged database, and Redis URLs match.
Only non-secret endpoint fingerprints appear in the retained receipt. It creates one isolated `.invalid`
user and sole-member workspace, creates the scan through `createScan()`, writes the normal
audit entry, and deliberately never calls `enqueueScan()`. After the five-minute orphan
grace period it rechecks admission, runtime, schedules, every nonterminal scan ID, queue
depth for both scan and webhook-retry work, and provenance before calling the exact-scan entry point that shares the normal
reconciliation lease, queue-state check, and `updateScanStatus()` lifecycle. It requires a
`FAILED/QUEUE_ORPHANED` result, zero durable `engine_start` events, and an empty final queue.
Before cleanup it writes a retained platform audit receipt bound to the fixture and immutable
runtime provenance. After successful cleanup it appends a second immutable platform audit
receipt bound to the first, so the durable trail distinguishes pending from completed cleanup.
Cleanup uses `cancelScan()` when needed, `removeScan()`, and the RLS-safe retryable
`deleteUserAccount()` path only when the deletion plan still contains exactly the disposable
workspace and no retained or blocked workspace; no unrelated scan row or BullMQ job/key is
reconciled or edited.

## Unified launch-assurance proof

`verify:launch-assurance` composes the evidence round-trip, fail-closed check,
readiness, Azure alert readback, authenticated cancellation, and shared queue
recovery into one ordered command that emits a single bounded JSON receipt.

Host prerequisites: reviewed checkout of the promoted product revision, Docker
with access to the promoted worker image, `az` authenticated for read-only
Monitor access, the worker runtime environment file, the egress pin file, and
(for full mode) an API credential and exact target scan/workspace IDs. Founder
authorization is an external prerequisite for every mutation mode.

Dry run (read-only, CI-safe):

```sh
pnpm --filter @lyrashield/worker verify:launch-assurance -- --dry-run \
  --azure-resource-group <rg>
```

Exit 0 means the available preflight checks passed (`overall: preflight_passed`);
mutation steps are `skipped` and are never summarized as proof.

Storage proof from the exact promoted image (disposable containers only):

```sh
pnpm --filter @lyrashield/worker verify:launch-assurance -- \
  --allow-storage-proof --worker-image "$LYRASHIELD_WORKER_IMAGE" \
  --worker-env-file /etc/lyrashield/worker.env \
  --egress-pin-file /run/lyrashield-egress-hosts \
  --azure-resource-group <rg>
```

The command runs the existing `verify-evidence-storage.ts` and
`verify-evidence-storage-fail-closed.ts` entrypoints inside uniquely named
containers, preserves their `*_OK` markers, removes only the containers it
created, and fails closed if either marker is absent.

Controlled failure injection (founder-authorized only):

```sh
pnpm --filter @lyrashield/worker verify:launch-assurance -- \
  --allow-storage-proof --worker-image "$LYRASHIELD_WORKER_IMAGE" \
  --worker-env-file /etc/lyrashield/worker.env \
  --egress-pin-file /run/lyrashield-egress-hosts \
  --azure-resource-group <rg> \
  --allow-failure-injection --scan-id <exact-scan-id> --workspace-id <exact-workspace-id> \
  --environment production \
  --incident-commander "<full name>" \
  --confirm-production "I AUTHORIZE LYRASHIELD FAILURE INJECTION"
```

Full mode refuses to proceed unless admission is stopped, schedules and webhook work are
zero, every active database scan is the selected scan, and BullMQ contains exactly that scan's
one expected job: waiting/delayed/prioritized for `QUEUED`, or active for
`PREFLIGHT`/`RUNNING`/`VERIFYING`. Missing, duplicated, state-mismatched, or unrelated scan
jobs fail closed without removal or replay. It also refuses when terminal provider cost
remains uncertain, the incident commander is absent, or the confirmation phrase is not
exact. A failed failure-injection preflight marks every later mutation step skipped. Cancellation
goes through the authenticated scan API; recovery goes through
`reconcileScanQueue()` exactly once. The command never deletes BullMQ keys,
calls `job.remove()`, auto-requeues, or synthesizes paid work.

The receipt contains the mode, timestamp, product revision, worker digest,
engine revision, selected scan/workspace, ordered step records
(`passed | failed | skipped`) with bounded reasons, cleanup result, and total
duration. It never includes secrets, evidence contents/URIs, raw queue jobs,
customer payloads, or provider tokens. `overall: passed` is not a security
certification and is always bounded to the exact revision and scan window
recorded in the receipt.

## Capacity and incident record

For each release, retain the Azure Monitor charts for worker CPU and app replicas/restarts,
the enabled alert rules, the alert action-group recipient, and the response record. Current
capacity alarms are worker VM unavailable, worker CPU above 85% for 15 minutes, app no
active replica, app restart, and any app `5xx`. Escalate sustained worker CPU above 85%,
replica loss, or repeated readiness failure before increasing concurrent scan admission.

## Billing and licensing

Keep Polar/Razorpay in test mode until founder authorizes live charges. A test-provider
event must leave one idempotent `WebhookEvent`, one applicable track result, and exactly
one usage or entitlement effect; replay it and confirm no second effect. Do not grant
minutes or reset a customer balance just to make a smoke test pass.

The app’s managed identity must retain `Key Vault Secrets User` on
`lyrashieldprodsecrets`; the three license-signing secrets must be enabled. Verify an
in-memory sign/verify round-trip from the running app identity before processing any
live Local order. Never copy a private key out of Key Vault for this test.
