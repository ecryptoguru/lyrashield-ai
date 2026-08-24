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

Before a controlled worker restart or failure injection, record enabled schedules,
non-terminal scans, and BullMQ waiting/delayed/prioritized/active counts. Do not
continue while unexpected work exists. After recovery, require all of:

1. `/api/ready/scans` returns worker `true`.
2. Worker image is healthy and its lease has refreshed.
3. Queue/database counts match their pre-test state.
4. No unexpected `engine_start` event occurred.
5. A synthetic stale scan becomes `FAILED` with `QUEUE_ORPHANED`; it is never requeued.

Use the queue reconciliation code path and its normal `updateScanStatus` lifecycle.
Do not delete BullMQ keys or alter a scan row directly to simulate this condition.

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
