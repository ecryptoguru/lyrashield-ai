# Operations runbooks

Founder- and operator-run procedures consolidated from standalone runbooks. Each section is founder-controlled; nothing here runs unattended.

## Current production readback — 2026-10-27

Product `2d4e168da544306bf6cc9958a55f14bbfcb717e3` passed [production release 40538483543](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40538483543). Provider readback showed app `0000507`, scanner `0000481` and proxy `0000347` at 100% traffic; scan readiness returned HTTP 200. Independent VM readback confirmed healthy worker `sha256:690bac6ed42d1c450af94055e270d5f21baa937771ba828e7e4871e501067fbe`, matching product and engine `3001517530300ca5f602536bfadcbd3c95ad3039` provenance and 23 PHP/Composer and coverage source hashes. Wait for release completion before VM RunCommand reads; never overlap worker promotion.

Controlled PHP Standard and Deep baseline acceptance passed on an earlier image. A later cold-cache Composer proposal succeeded and its sealed artifact was checked; the unchanged-source negative retest failed as expected and left the finding OPEN/DETECTED. The approval-bound PR and positive retest remain pending. PR #1043 is deployed by [release 40538483543](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40538483543). On October 28, the approved GitHub App write permissions were accepted. The controlled PR attempt failed on a missing blob SHA during an existing-file update; The recorded attempt predates the blob-bound update correction. Preserve its failed receipt and unchanged orphan branch; verify the corrected release and complete the positive workflow before claiming acceptance. Inspect only server-produced sealed artifacts and preserve compatibility notices and immutable evidence. Never update finding or ledger state directly or remove queue keys.

The October 25 [backup / isolated restore 40172080687](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/40172080687) passed verified TLS, schema/audit/readiness, cleanup and public-safe proof publication. App and worker log ingestion were observed. The three reconciliation/catalog rules exist and remain intentionally disabled under the October 12 noise policy. The operator receiver is verified, and one Azure test notification reached the operator inbox on October 27; this does not prove individual alert-rule behavior. Preserve receiver and alert settings.

On the earlier `d92315ac` marketing revision, 17 pages and 368 unique links had no link errors. Two page-ready desktop/mobile rounds across seven articles showed loaded images and cluster, checker and signup links with no horizontal overflow. Synthetic checker examples and the separate Windows notice were exercised. Customer runtime identity, backports, earlier compromise, compatibility and commercial/provider acceptance remain separate. See [PRD §8](../PRD.md#8-current-production-evidence).

## Historical production readback — 2026-10-01

Product `4822306e24f375800981bf282fd992a9c15dcde8` passed [main CI](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36905268255), [production release](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36908006265), and [scan-readiness workflow](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36912801887). Azure readback found the app, scanner, and egress proxy at 100% traffic on that revision, and the worker promotion check passed for its immutable image. A fresh public `GET https://app.lyrashieldai.com/api/ready/scans` at `2026-10-01T20:15:18Z` returned HTTP 200 with `{"status":"ready","checks":{"worker":true}}` and `Cache-Control: no-store`.

This establishes scan-admission readiness for that deployment. It does not establish billing reconciliation, settlement, a paid scan on this revision, authenticated client use, or commercial readiness. The Cloud billing flags were read back as `public` and Local flags as `off`; this is configuration, not permission or payment proof. See [PRD §8](../PRD.md#8-current-production-evidence) for exact revisions and image digests.

The 2026-10-01 report-only reconciliation failed Polar with HTTP 403 `insufficient_scope`. Its receipt recorded `completed=false`, zero Polar and Razorpay rows checked, zero pack credits verified and a coverage start of `2026-09-04T08:03:51Z`. The worker calls providers sequentially, but does not retain response row counts. Do not call this dated receipt complete reconciliation or reset the baseline. At that readback, the app-to-worker release sync copied the app Polar credential into worker Key Vault, so a worker-only replacement was expected to be overwritten on the next release. Confirm the current grant and sync contract before changing credentials, then use the guarded refresh/promotion path and rerun report-only reconciliation. No credential values were read or changed during that readback.

The October 11 inventory found three source-declared rules absent and did not test delivery. Its isolated restore passed the then-current schema/migrations, audit and readiness but withheld proof at the TLS gate. Later rule, delivery and restore evidence is recorded in [PRD §8](../PRD.md#8-current-production-evidence).

## Live checkout verification

> **Founder-controlled.** This runbook turns on real money. Stop conditions are
> explicit — nothing here runs unattended.

### Historical configuration readback (2026-09-14)

- Azure app revision `lyrashield-app--0000358` (release `34842662910`, product
  `9cde77d2`, 100% traffic) has
  `POLAR_BILLING_ADMISSION=public` and `RAZORPAY_BILLING_ADMISSION=public`;
  both Local admissions are `off` and the canary allowlist is empty. Refresh
  deployed configuration before each run. An admission change requires an
  explicit provider/surface/workspace decision and a redeploy.
- Proven in isolated staging (run `33438477364`, product `5e6c68ba`): Polar
  Sandbox + Razorpay Test hosted checkout, provider-delivered signed webhooks,
  entitlement/usage DB effects, replay idempotency, immediate cancellation,
  redacted receipts, cleanup.
- **Not yet proven live:** a real charge, settlement, payout, tax handling,
  Razorpay hosted-checkout methods above INR 15,000, Polar settlement
  readiness. Staging proof does not transfer to live rails.

### Report-only billing reconciliation

The worker checks paid Polar orders, captured Razorpay payments and
unprocessed Polar/Razorpay webhook events at startup and every 24 hours —
the sweep is scoped to the money rails, so deliveries for other providers are
never billing drift. Provider order/payment
status can change after creation, so each run rescans a 24-day window. This
covers Polar's documented 21-day subscription retry schedule and Razorpay's
late-authorization capture window with a small scheduler-delay margin. The
first attempt sets a durable coverage baseline 24 days before that attempt;
each successful run advances a system-owned checkpoint, and later runs include
the same 24-day overlap. A completed run suppresses provider re-listing for
24 hours; replica restarts no longer re-list providers while the lease is
held. Provider or database failures leave the checkpoint
unchanged, so a later run catches up across outages. A cross-worker lease
prevents overlapping sweeps. Each run additionally verifies that every fully
processed pack settlement produced its `MinutePack` credit keyed by
(provider, externalId) — a missing credit reports `settlement_credit_missing`
drift — and reports duplicate settlement receipts (`reconciliation_duplicates`)
and refunds whose settlement was never recorded (`refund_without_settlement`)
as operator alerts inside the coverage window. Older unresolved exceptions
outside the window stay visible through the separate `reconciliation_backlog`
signal. This job only reports and alerts: it does not
replay webhook tracks or change billing, entitlements or money. The credential
scopes and production provider pins still need separate verification before
this code is considered operational. The first-attempt baseline is the
forward-monitoring start: the job does not backfill provider payments older
than that point. Complete any separate historical payment review before
enabling production credentials.

The 2026-10-01 receipt was incomplete because Polar returned `insufficient_scope`; see the dated production readback above. Razorpay is invoked sequentially even when Polar fails, but the stored receipt does not retain provider response counts. Treat the recorded zero counters as insufficient to prove full provider coverage.

### Monitoring noise and terminal provider expense

The 2026-10-12 corrective Azure readback verified the enabled operator action group
with Ankit as its sole common-schema email receiver. The three additional rules
`reconciliation-backlog`, `reconciliation-duplicates` and `webhook-catalog-rejection`
are disabled with their definitions retained. This stops their future enabled-rule
evaluation; it does not establish a refund or prove email delivery. The source
provisioner excludes these additions and rejects a different primary inbox.

The worker samples terminal cost health every five minutes independently of the
hourly idle queue reconciliation. Each observation is explicitly `healthy`,
`unhealthy` or `unknown`; only a successful empty read is healthy. Logs contain
the safe scan ID and age for an unhealthy observation, never target content or
raw database errors. The cost query uses the latest observation time, treats
duplicates conservatively and keeps missing, failed or stale observations
unhealthy. Recovery needs a recent positive healthy observation. This source
behavior needs deployment plus the scoped cost-query update before it is live.

`node ops/monitoring/reduce-noise.mjs --subscription <id> --resource-group <group>`
prints a bounded diff without applying it. It preserves individual-error detection
while removing its email action, retains the sustained `>5` errors in five minutes
rule and updates the existing cost query. `--apply` requires unchanged preflight
state and verifies readback. It never creates alerts or edits replica thresholds.
Do not use the full provisioner for an existing notification correction.

`pnpm --filter @lyrashield/worker review:terminal-cost-disposition` remains read-only
unless its existing production apply confirmation is supplied. Version 1 retains
the exact two historical zero-cost reviews and their evidence requirements.
Version 2 accepts one ordinary `FAILED` REPO scan with a preserved positive provider
cost, null billed cost and the exact `updatedAt`. Its conclusion must state
`customerBilling: "non_billable_failed_scan"`; the conclusion, persisted provider
cost and digest-bound provider evidence must agree at ten decimal places.
The provider evidence file uses version 2, the exact scan/resource ID and execution
window, query timestamp, positive request count and decimal-string provider cost.
An approved verified MFA-enabled platform operator is rechecked inside the atomic
audit/event transaction. No scan cost, customer usage or billing row is updated.
Missing or mismatched audits, deleted receipts, a changed scan version or a newly
recorded positive expense keep the condition unresolved. Applying a reviewed
disposition is a separate authorized financial-record operation; this change does
not apply a historical production disposition.

Version 3 adds a separate internal expense review for the exact historical FAILED
scan named in `historical-failed-expense-contract.ts`. Its original writer used
`Number.toFixed(6)` and Decimal(12,6); the later precision migration retained the
rounded value. The receipt keeps the original engine amount, stored expense and
rounding difference as distinct fields, bound to the pinned historical source
revision and the original scan-owned usage event's PostgreSQL JSONB digest.
This is scan-bound engine/database evidence, not Azure provider-metric or invoice
evidence. Legacy manifest checksum verification remains `legacy_unavailable`.
The v2/current ten-decimal comparison stays exact.

The default dry-run and serializable apply transaction recheck the nondeleted
original event, source revision, exact scan state and zero scan-linked customer
usage under the sponsor's account ownership. Applying a separately approved v3
receipt appends only the matching operator audit and
`terminal_cost_legacy_expense_reviewed` event; it preserves scan expense and
customer billing state and records `providerReconciliation: "unavailable"`.
This separate event does not satisfy the provider-cost predicate or clear its
alert, and does not relax destructive failure-injection/queue-orphan preflights.
The historical item is an internal accounting exception; normal customer scan
admission checks the worker lease and admission stop, and deployment does not
depend on this record. Provider reconciliation still needs independently
attributable provider receipts. Production application requires separate approval.

### Pending read-only evidence audits

These audits have not been run. They are evidence collection only and must not write historical records, alter receipts, reset checkpoints, replay billing events, or change scan/finding states.

**Task 1 — verify both manifests for authorized retest receipts.** First obtain the exact authorized `workspaceId`, original source `scanId` and retest `scanId` from the workspace owner/operator and confirm the retest relationship through the existing workspace-scoped read path. Under `withWorkspaceRLS(workspaceId, ...)`, read only each stored row's `checksum`, `checksumInput` and parsed `manifest`, then call the existing [`verifyStoredManifestChecksum`](../packages/db/src/manifest-checksum.ts) helper once for the original manifest and once for the retest manifest. There is no dedicated audit CLI or SQL checksum substitute. Keep the identifier-to-result mapping in the restricted operator record; report only aggregate `MATCH`/`MISMATCH`/`UNAVAILABLE` counts and receipt-state counts. Do not print scan/workspace IDs, manifest contents, evidence, hashes or storage URIs in the summary. Make no historical writes. The source audit of the 2026-10-01 release found a finalizer gap but did not inspect production rows or show an incorrect validation. The fix shipped on 2026-10-10 and remains in current product revision `851c16f2bdb0558cd5cff62b3d8de4cd5a70d437`; this audit is still useful only if authorized operators need to classify existing receipts. See [PRD §9](../PRD.md#9-release-status).

**Task 2 — bounded delegated-operation impact sample.** The audit host currently has `/tmp/delegated-operation-impact.sql`; it is a temporary, unversioned template and has not been run. Inspect the exact file before use. It opens a `READ ONLY` transaction, applies a 5-second statement timeout, binds workspace RLS, samples at most 500 rows, emits aggregate counts plus bounded sanitized markers, and rolls back. Before running it, obtain and verify the exact authorized `workspace_id`, `principal_type`, `principal_id`, and `authorization_version` from the current caller/grant; do not guess or broaden those values. Retain only aggregate counts and sanitized markers from the query. A 500-row sample cannot prove absence of older duplicates. Do not run a write query or change authorization/operation records as part of this audit.

### Step 0 — preflight (safe, read-only)

```bash
pnpm --filter @lyrashield/worker verify:checkout-readiness
```

Validates admission posture, provider credentials and catalog completeness
(plan × interval + pack + local keys). Exits non-zero on gaps. This is a
config check, not a payment test.

### Step 1 — canary admission

1. If moving Cloud admission from its current `public` posture to `canary`,
   record the founder-approved workspace IDs in `BILLING_CANARY_WORKSPACE_IDS`.
   The protected `Configure Cloud billing admission` workflow changes **both**
   Polar and Razorpay Cloud flags together. Record both resulting values; do
   not assume this workflow can change one provider alone.
2. Redeploy web through the protected release path and read back the revision,
   traffic, flags and allowlist before purchase.
3. With an authenticated billing manager session and valid Origin header,
   send `POST /billing/checkout` with JSON `workspaceId`, `plan` and
   `interval`. An excluded workspace must receive external HTTP 503
   `PAYMENTS_UNAVAILABLE`; the internal decision reason is `not_canary`.
   Check the founder workspace can proceed without completing payment.
4. Re-run preflight; confirm `admission_posture` shows `canary` + ids set.

### Step 2 — live purchase (founder, real card)

Use the founder canary account. Purchase the **cheapest self-serve paid plan**
(STARTER monthly, $29) — never test with LAUNCH_ASSURANCE first.

Evidence to retain per purchase:

- Provider dashboard receipt (hosted checkout session id).
- `WebhookEvent` row: provider, event type, external id, `processed` and
  `processedAt`; inspect related `WebhookEventTrack` rows for billing status,
  attempts and completion. Retain provider signature-verification evidence
  from the webhook handling path. Do not copy the stored raw payload.
- `BillingAccount` row: `status=active`, `currentPlan`, `currentPeriodEnd`,
  `externalId` — confirms entitlement landed via webhook, not the return URL.
- `UsageRecord` monthly grant row for the plan's agent-minutes.
- A repeat checkout attempt no longer hits `CHECKOUT_IN_PROGRESS` after the
  90-second Redis lock expires; there is no checkout-claim database row.
- Screenshot of `/dashboard/billing` post-webhook (success notice + plan).

Use privileged, read-only, account-bound queries when collecting application
receipts; parameterize the exact provider event and founder account IDs and
do not select `WebhookEvent.payload` or payment credentials:

```sql
SELECT id, provider, "eventType", "externalId", processed, "processedAt"
FROM "WebhookEvent" WHERE provider = $1 AND "externalId" = $2;

SELECT track, status, attempts, "completedAt"
FROM "WebhookEventTrack" WHERE "webhookEventId" = $1;

SELECT provider, status, "currentPlan", "currentPeriodEnd", "externalId"
FROM "BillingAccount" WHERE "accountId" = $1 AND provider = $2 AND "deletedAt" IS NULL;

SELECT kind, quantity, "cycleStart", "createdAt"
FROM "UsageRecord" WHERE "accountId" = $1 AND "createdAt" >= $2;
```

Then immediately test cancellation from the customer portal and retain the
`canceled` webhook evidence. **Refund path is a separate live check** — retain
`status=refunded` row evidence before calling the refund flow proven.

### Step 3 — Razorpay rail

Repeat with `RAZORPAY_BILLING_ADMISSION=canary`, an INR method and the INR
plan catalog. Note: hosted-checkout methods above INR 15,000 are unproven —
test the highest INR tier deliberately, not incidentally. Razorpay packs price
dynamically via `BILLING_USD_INR_RATE` — verify the paise amount on the
payment link before paying.

### Step 4 — public admission (founder decision)

Only after: live charge + webhook + entitlement + cancel + refund evidence is
retained for the chosen rail and `WebhookEventTrack` `dead_letter` count is 0.
The founder's platform-admin account is excluded from `active_paid_accounts`:
its entitlement must update, but that Growth card must not increment. A
separately approved non-admin canary is needed to verify aggregate inclusion.

Flip to `public` per provider. `canary` remains available as a kill-switch.

### Durable webhook-track UTC schema cutover

The protected-main Azure release automatically selects the first durable
webhook writer upgrade only after its read-only classifier verifies the exact
allowlisted legacy writers and database schema. A manual `Deploy to Azure`
dispatch requires exact current `main` and uses the same classifier. No cutover
flag or typed confirmation is needed. The maintenance workflow drains existing
queues, pauses app/scanner writers, stops the worker and checks the database
before migration. Unknown or mixed baselines fail closed; see the
[cutover contract](reviews/2026-09-30/webhook-production-cutover.md).

Legacy `nextAttemptAt` and `leaseExpiresAt` values must both be empty after
writers stop. The UTC migration then preserves NULLs and needs no historical
timezone review, signing key or operator attestation. Remaining schedules,
leases or a partial UTC schema stop the migration. Let existing work complete
or use receipt-aware recovery; never clear data or replay paid work to pass.

The workflow retains its owned maintenance record across retries, applies
additive migrations, verifies compatible images and readiness, then reopens
ingress. Rerun the same failed Actions run for recovery. A failed migration
never reverses schema or resumes a legacy writer.

### CI and release flow

Pull requests run the required security, lint/typecheck/test/build and pinned
engine/worker checks. Protected main requires an up-to-date base and passing
checks. A merge starts `Release production` directly; it does not run the PR
pipeline again. Azure and Cloudflare route independently from their last
successful deployed revision, including pending changes from failed releases.

Azure builds each image once and verifies the exact worker digest before
promotion. Cloudflare retains generated-artifact validation and live route/
revision checks. Production Lighthouse scores run nightly or on demand,
with reports and unchanged thresholds, outside the deployment path.

### Checkout rollback

Set the affected `*_BILLING_ADMISSION` back to `off` and redeploy. Existing
subscriptions are unaffected — admission gates _new_ purchases only. Failed
tracks below the retry cap can reconcile; `dead_letter` tracks are not
automatically re-enqueued. Check `admin → Billing`, retain event and track IDs
and diagnose provider delivery and processing without exposing raw payloads.

An elevated platform administrator can request recovery with
`POST /api/admin/webhook-tracks/{trackId}/retry`. The operation requires a
cookie session with recent TOTP elevation, a single-use action nonce, the
expected generation and a bounded audit reason. It only retries replay-safe
minute-pack billing events with a verified provider receipt. It also accepts a
historical `pending` or `failed` pack track, or an orphaned `processing` track
with no claim token or lease, only when both old and UTC due-time columns are
NULL. These rows are never retried automatically because the old worker may
have completed an effect without recording an attempt. Each recovery archives
that cycle's attempts, resets the bounded automatic attempt budget and allows
at most three operator recoveries. Stale generations, exhausted
recovery counts, subscriptions, licenses and affiliate effects are rejected.
The durable row remains due if Redis enqueue fails, so the worker sweep can
recover it. Never edit database state or enqueue a track directly.

For an unsafe dead letter, or a historical null-due pending, failed or orphaned
processing track whose effect must not be replayed, use
`POST /api/admin/webhook-tracks/{trackId}/disposition`. It requires a separate
TOTP elevation, single-use action nonce, expected generation, one of the
bounded reasons (`effect_confirmed` or `no_effect_required`) and a short opaque
evidence reference. The transaction records the disposition in the platform
audit log and moves the track to `reviewed`; it never enqueues a job or calls a
provider handler. Use `effect_confirmed` only after the actual entitlement,
license, refund or affiliate effect is verified or corrected through its own
audited workflow. Use `no_effect_required` only when the provider receipt proves
no business effect was due. A reviewed track is not a successful payment or
fulfillment receipt. It is terminal for retries, reduces the dead-letter count
and, once every required track is succeeded or reviewed, marks the parent event
processed so duplicate delivery cannot run the handler again. If a required
business effect is missing and cannot be replayed safely, leave the track
unresolved until an approved domain-specific correction is complete.

Provider redelivery may retry eligible nonterminal tracks but can expire or be
rejected as stale. Keep the affected rail unready until the provider receipt,
track state and audit entry have been reviewed.

### What this runbook does not cover

Payouts (RazorpayX/Payoneer), tax-form operations, marketplace listing
payments — separate founder workstreams with their own gates.

## License signing-key compromise (FF4)

> **Severity: Critical.** This runbook records the current response boundary.
> The repository does not yet implement a safe end-to-end signing-key rotation.

### Current implementation

- In production, the app reads a PEM private-key secret from Azure Key Vault.
  The secret name comes from `LICENSE_SIGNING_PRIVATE_KEY_SECRET_NAME`; the
  vault comes from `LYRASHIELD_KEY_VAULT_NAME`. The app uses its managed
  identity. Do not create an Azure Key Vault cryptographic key: the current
  signer expects a PEM secret value.
- `LICENSE_SIGNING_KEY_ID` is written to each issued license record and file.
  The Desktop client loads one compiled public key from
  `apps/desktop/src-tauri/resources/license-signing-public-key.pem`; there is
  no multi-key trust store or bundled revocation list.
- `POST /api/licenses/revoke` currently returns `503 ADMIN_ACTION_DISABLED`.
  Existing activation, renewal and verification paths check the persisted
  `License.revoked` flag, but this is not an available operator mutation path.
- Replacing the Key Vault secret or compiled Desktop public key in isolation
  would leave existing license files unverifiable or block new issuance. The
  current application does not provide a coordinated rotation or reissue flow.

### Response

1. Notify the founder and incident owner. Record the detection time, suspected
   exposure window, affected Key Vault secret name and known access principals.
2. Preserve the relevant Key Vault access/audit records and deployment revision.
   Do not copy the PEM, license keys, or raw license files into tickets or logs.
3. Have the Azure owner review and contain unauthorized access to the Key Vault
   and managed identity. Preserve access needed by the incident responders.
4. Do **not** overwrite the PEM secret, change `LICENSE_SIGNING_KEY_ID`, or ship
   a new Desktop public key as an isolated action. The current product has no
   dual-key overlap and no enabled license-revocation mutation route.
5. Before rotating, engineering must prepare and review a coordinated change
   that keeps existing customer licenses recoverable, updates server signing
   and verification, updates the one bundled Desktop public key, and provides
   an authorized audited revocation/reissue path. Test it against existing
   signed-license fixtures and both online and offline Desktop verification.
6. To scope records signed with a known compromised key id, use a read-only,
   parameterized query that avoids customer email and key material:

   ```sql
   SELECT id, sku, "signingKeyId", "issuedAt", revoked, "revokedAt"
   FROM "License"
   WHERE "signingKeyId" = $1
   ORDER BY "createdAt";
   ```

7. Record the incident timeline, access review, affected record count, approved
   remediation, validation results and customer communications in the incident
   record. Keep public claims bounded to the evidence retained.

Do not claim the key is rotated, licenses are revoked, or Desktop clients trust a
replacement key until the coordinated implementation is merged, released and
verified against the deployed app and a clean Desktop profile.

## Affiliate payout operations

This section retains the approved payout operating model and the unresolved provider and tax gates. It is an internal execution checklist, not legal or tax advice. Current provider requirements and Indian tax treatment must be confirmed with the paying entity's authorized dealer bank and qualified tax adviser before production payouts.

### Approved operating model

- The paying entity is the Indian company. Polar collects payments only and does not pay affiliates.
- India affiliate payouts use RazorpayX in INR.
- The planned non-India rail is Payoneer Enterprise Mass Payouts, subject to partnership and API approval. No non-India payout provider is currently approved.
- Payout eligibility remains a $100 minimum, monthly net-30 payment on the 15th, a 30-day hold, completed tax-form gate, a 25% reserve for a new affiliate's first 90 days and automatic clawback for provider-confirmed refunds or chargebacks.
- Payouts remain disabled until provider credentials, recipient validation, delivery webhooks, idempotency, rejection handling, reconciliation, tax-form handling and operator procedures pass production-scoped verification.

### Gates before activation

- Obtain and verify RazorpayX production payout access for domestic INR payouts.
- Obtain Payoneer partnership approval, API access, commercial terms, recipient KYC/tax flow and webhook behavior.
- Confirm the outward-remittance funding path with the Indian authorized dealer bank.
- Confirm the applicable purpose code, Form 15CA/15CB process, TDS treatment including section 194H, GST treatment for registered affiliates and DTAA or treaty handling for non-residents.
- Record provider-hosted delivery, application and ledger effects, replay idempotency, rejection and ambiguous-outcome handling, reconciliation, cancellation or recovery behavior and redacted evidence before enabling scheduled payouts.
- Implement a bounded stuck-PROCESSING recovery sweep before activation: query provider status for payouts aged past a threshold; provider-confirmed PAID finalizes the payout and marks its RESERVED commissions PAID; only provider-confirmed FAILED or equivalent authoritative proof that no payout was delivered, marks the payout FAILED and releases its RESERVED commissions back to AVAILABLE. Missing, unavailable, pending or otherwise ambiguous provider status remains PROCESSING with its commissions RESERVED for operator reconciliation. Apply every transition through compare-and-set transactions on the current status so concurrent schedulers cannot double-finalize.

The implementation state remains defined by `AGENTS.md`, `PRD.md` and code under `packages/affiliate`. Historical provider comparisons and planning rationale remain in Git at commit `e3fa791f` under `monetization.md`.

## Owner-approved manual isolated restore

`production-backup.yml` has an opt-in manual `isolated_restore=true` mode. It
requires `restore=true`, `expected_source_sha` equal to the reviewed current
main SHA, and original run attempt 1 in both jobs. Dispatch only after separate
owner approval for production-data processing; a draft PR or merge is not
execution approval. A changed SHA or failed attempt requires new review rather
than a rerun.

This mode creates one new encrypted `public`/`app` production backup using the
existing DB/R2/GPG configuration. It skips retention deletion entirely, then
restores that run's object with ETag `If-Match` and ciphertext/plaintext SHA256
checks into disposable GitHub-runner PostgreSQL 17. Redis and the application
bind only loopback. Schema, audit-chain and readiness verification produce the
existing digest-only v2 artifact, retained 30 days. The new encrypted object
remains in the existing bucket and is subject to ordinary scheduled 30-day
retention; this mode does not delete it or any older object.

Plaintext dumps, audit exports and command/error logs stay in a private 0700
runner directory with 0600 files. Sensitive phases return exit status without
publishing diagnostics. The first isolated `docker rm -fv` removes anonymous
restored-data volumes together with their containers; `always()` cleanup also
removes private files and named backup containers; application cleanup validates the session leader's UID, process
group, session and start time before signalling its group. Cleanup refuses
stale identity. Hard runner loss or orphaned/unverifiable processes rely on
hosted-runner teardown, so explicit cleanup is not a secure-erasure guarantee.
The backup and restore jobs have respective 20/25-minute timeouts; queue/setup
waits mean this is not a 45-minute wall-clock limit.

Existing credentials authenticate only to their original production database
and R2 endpoint; the passphrase is used locally. Full private production data
is decrypted on GitHub's ephemeral runner. No restored writes target
production. No new cloud resources, grants, credentials, maintenance hold,
writer stop, migration or cutover is part of this drill. Ordinary scheduled
backup/weekly-restore behavior is unchanged.

## Optional scan relay activation

The proxy's ordinary `/health` and scan-worker readiness do not establish scan-scoped relay availability. `/health/relay` reports a nonsecret boolean only. Workers publish ordinary readiness and an expiring relay capability atomically in one Redis key after complete local configuration and a bounded capability probe; admission requires all active consumers of the shared scan queue to support relay jobs. A missing capability refuses Standard and Deep/Custom URL/API reviews before entitlement mutation or scan creation. Repository and Surface/Safe/Quick reviews retain their existing gates. The composer offers the surface option explicitly; it does not silently downgrade a review.

Activation is a separate operator-approved change. Preparing or merging code does not provision relay credentials. Keep `LYRASHIELD_TARGET_RELAY_ENABLED` unset or `0` in the release environment until the secure handoff is complete.

1. Provision a strong shared value (at least 32 characters) directly in the approved Azure Key Vault as `worker-relay-signing-secret`, using the operator's secret interface. Never paste it into chat, source, shell arguments or logs. The proxy and worker consume the same stored secret; GitHub receives only activation metadata and managed-identity references.
2. Grant the proxy and worker identities `Key Vault Secrets User` only at this existing secret's resource scope. Confirm each exact identity separately. Do not grant the web app access to the relay secret. The deployment preflight checks existing access and latest-version enabled metadata; it never creates keys or role assignments.
3. Set the release environment's nonsecret `LYRASHIELD_TARGET_RELAY_ENABLED=1`. The egress rollout binds the existing secret with system identity to `LYRASHIELD_RELAY_SIGNING_SECRET`. Retain exactly one proxy replica and the existing admin-secret binding and firewall controls.
4. Through the worker's approved Key Vault configuration channel, set nonsecret `worker-target-relay-enabled=1`. Refresh derives `LYRASHIELD_TARGET_RELAY_URL` from existing `worker-egress-proxy-url` and loads the shared signing secret atomically. The admin secret remains `worker-egress-proxy-secret`. A missing/short signing value fails refresh without replacing the prior environment file. Both sides must be ready before a relay capability can be advertised.
5. Use the guarded release/worker promotion path. Verify deployed revisions, `/health/relay`, the worker lease and advisory/POST refusal parity. A boolean capability does not prove domain verification, correct shared-key agreement, actual target transport or a completed scan. Perform any controlled paid URL acceptance only with separate explicit authorization.

For rollback, set the release flag to `0` and the worker activation setting to `0`, then use the guarded rollout/promotion path. The proxy removes the signing environment binding; worker refresh omits the relay URL/signing configuration; relay capability disappears while ordinary scan readiness stays independent. Do not delete or rotate the shared secret as a rollback shortcut. General admission remains protected by the existing queue stop and worker readiness gates.
