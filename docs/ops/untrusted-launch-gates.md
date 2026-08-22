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

Run inside the promoted worker container, with production secrets already loaded:

```sh
./apps/worker/node_modules/.bin/tsx apps/worker/src/operations/verify-evidence-storage.ts
./apps/worker/node_modules/.bin/tsx apps/worker/src/operations/verify-evidence-storage-fail-closed.ts
```

Both commands must print their respective `*_OK` marker. The first writes a unique
non-sensitive artifact, verifies ciphertext, authenticated round-trip, unauthenticated
denial, and cleanup. The second has no storage side effect and proves a missing KEK
blocks configuration.

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
