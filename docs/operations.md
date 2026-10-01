# Operations runbooks

Founder- and operator-run procedures consolidated from standalone runbooks. Each section is founder-controlled; nothing here runs unattended.

## Current production readback — 2026-10-01

Product `4822306e24f375800981bf282fd992a9c15dcde8` passed [main CI](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36905268255), [production release](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36908006265), and [scan-readiness workflow](https://github.com/ecryptoguru/lyrashield-ai/actions/runs/36912801887). Azure readback found the app, scanner, and egress proxy at 100% traffic on that revision, and the worker promotion check passed for its immutable image. A fresh public `GET https://app.lyrashieldai.com/api/ready/scans` at `2026-10-01T20:15:18Z` returned HTTP 200 with `{"status":"ready","checks":{"worker":true}}` and `Cache-Control: no-store`.

This establishes scan-admission readiness for that deployment. It does not establish billing reconciliation, settlement, a paid scan on this revision, authenticated client use, or commercial readiness. The Cloud billing flags were read back as `public` and Local flags as `off`; this is configuration, not permission or payment proof. See [PRD §8](../PRD.md#8-current-production-evidence) for exact revisions and image digests.

The latest report-only reconciliation failed Polar with HTTP 403 `insufficient_scope` on `2026-10-01T19:08:19Z`. Its receipt has `completed=false`, `polarChecked=0`, `razorpayChecked=0`, `packCreditsVerified=0`, and a coverage start of `2026-09-04T08:03:51Z`. The worker calls the providers sequentially, but does not retain response row counts. Do not call this complete reconciliation or reset the baseline. The app-to-worker release sync copies the app Polar credential into worker Key Vault, so a worker-only replacement will be overwritten on the next release. Correct the source-of-truth grant or approve a distinct worker binding, then use the guarded refresh/promotion path and rerun report-only reconciliation. No credentials were read or changed for this documentation update.

Live alert rules include `reconciliation_drift`; they do not yet include separate rules for emitted `reconciliation_backlog` and `reconciliation_duplicates`. Alert receiver delivery is unverified. The latest recorded isolated restore predates the migrations in the 2026-10-01 release, so a post-release backup and restore drill remains pending.

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

The 2026-10-01 receipt was incomplete because Polar returned `insufficient_scope`; see the current production readback above. Razorpay is invoked sequentially even when Polar fails, but the stored receipt does not retain provider response counts. Treat the recorded zero counters as insufficient to prove full provider coverage.

### Pending read-only evidence audits

These audits have not been run. They are evidence collection only and must not write historical records, alter receipts, reset checkpoints, replay billing events, or change scan/finding states.

**Task 1 — verify both manifests for authorized retest receipts.** First obtain the exact authorized `workspaceId`, original source `scanId`, and retest `scanId` from the workspace owner/operator and confirm the retest relationship through the existing workspace-scoped read path. Under `withWorkspaceRLS(workspaceId, ...)`, read only each stored row's `checksum`, `checksumInput`, and parsed `manifest`, then call the existing [`verifyStoredManifestChecksum`](../packages/db/src/manifest-checksum.ts) helper once for the original manifest and once for the retest manifest. There is no dedicated audit CLI or SQL checksum substitute. Keep the identifier-to-result mapping in the restricted operator record; report only aggregate `MATCH`/`MISMATCH`/`UNAVAILABLE` counts and receipt-state counts. Do not print scan/workspace IDs, manifest contents, evidence, hashes, or storage URIs in the summary. Make no historical writes. The source audit found a deployed finalizer gap, but did not inspect production rows or show an incorrect validation; see [PRD §9](../PRD.md#9-release-status).

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

### Checkout rollback

Set the affected `*_BILLING_ADMISSION` back to `off` and redeploy. Existing
subscriptions are unaffected — admission gates _new_ purchases only. Failed
tracks below the retry cap can reconcile; `dead_letter` tracks are terminal and
are **not** automatically re-enqueued. Check `admin → Billing`, retain event
and track IDs and diagnose provider delivery and processing without exposing
raw payloads. There is currently no supported operator retry/reset operation
for dead-letter tracks. Do not edit database state or enqueue a track directly.
Provider redelivery may retry eligible nonterminal tracks but can expire or be
rejected as stale. Keep the affected rail unready until an authorized recovery
operation is implemented and its idempotency and audit behavior are verified.

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
