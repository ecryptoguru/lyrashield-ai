# Operations runbooks

Founder- and operator-run procedures consolidated from standalone runbooks. Each section is founder-controlled; nothing here runs unattended.

## Live checkout verification

> **Founder-controlled.** This runbook turns on real money. Stop conditions are
> explicit — nothing here runs unattended.

### Current state (read back 2026-09-14)

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
and track IDs, diagnose provider delivery and processing without exposing raw
payloads and use a separately authorized bounded recovery operation. Do not
mark a rail ready with unresolved dead letters.

### What this runbook does not cover

Payouts (RazorpayX/Payoneer), tax-form operations, marketplace listing
payments — separate founder workstreams with their own gates.

## License signing-key compromise (FF4)

> **Severity: Critical.** Execute immediately upon suspicion that the ed25519
> license signing private key has been exposed. Time-to-rotate is the primary
> damage-control metric.

### When to use this runbook

Trigger this runbook when **any** of the following occur:

- The `LICENSE_SIGNING_PRIVATE_KEY` env var or Azure Key Vault secret is found
  in a log, commit, artifact or third-party system outside its intended store.
- An attacker demonstrates the ability to forge valid license signatures.
- A Key Vault access audit shows unauthorized access to the signing key.
- An insider with key access departs under adversarial circumstances.
- Any unexplained valid license file appears that was not issued by the
  `/api/licenses/issue` or `/api/licenses/activate` endpoints.

### Prerequisites

- Founder (OWNER) access to the LyraShield platform.
- Azure Key Vault admin access (production signing key store).
- Ability to ship a desktop app update (signed and notarized).
- Brevo email access for customer notification.

### Step 1 — Generate a new ed25519 keypair in Azure Key Vault

1. **Rotate the Key Vault key.** In the Azure Portal, navigate to the Key Vault
   that stores the license signing key and create a new ed25519 key:
   - Key name: `license-signing-v{N}` (increment the version, e.g. `v2`).
   - Key type: `Ed25519`.
   - Set rotation policy to notify 30 days before expiry.

2. **Export the public key** as a SPKI PEM. This will be bundled into the next
   desktop app release so the client trusts signatures from the new key.

3. **Update `LICENSE_SIGNING_KEY_ID`** to the new key identifier (e.g.
   `license-key-v2`). This is how the client selects the correct public key
   for verification and how revocation lists are scoped.

4. **Do NOT delete the old key** from Key Vault yet — it is needed during the
   dual-sign overlap window (Step 3).

### Step 2 — Ship an update that trusts the new key + bundles a revocation list

1. **Add the new public key** to the desktop app's bundled trusted keys list.
   The client should accept signatures from both the old and new keys during
   the overlap window, then drop the old key after the window closes.

2. **Generate a revocation list** of all licenses signed by the compromised key.
   Query the database:

   ```sql
   SELECT id, "ownerEmail", sku, "signingKeyId"
   FROM "License"
   WHERE "signingKeyId" = 'license-key-v1'  -- the compromised key ID
   ORDER BY "createdAt";
   ```

3. **Bundle the revocation list** into the desktop app update as a signed JSON
   file. The client must refuse any license file whose `signingKeyId` appears
   in the revocation list **after** the overlap window closes.

4. **Ship the update.** The update itself must be installable by all users
   (including those whose update eligibility has expired) — this is a security
   update that overrides the normal eligibility gate. The perpetual fallback
   policy is suspended for this specific build.

### Step 3 — Dual-sign during the overlap window

1. **Update the server** to sign new and re-issued licenses with the **new**
   key only (`LICENSE_SIGNING_KEY_ID = license-key-v2`).

2. **During the overlap window (recommended: 30 days):**
   - The desktop client accepts signatures from both `license-key-v1` (old)
     and `license-key-v2` (new) public keys.
   - The server signs exclusively with the new key.
   - Any license file signed by the old key that is NOT in the revocation list
     remains valid until the user re-activates (which re-issues with the new key).

3. **After the overlap window closes:**
   - The desktop client drops trust in the old key entirely.
   - Any license file still signed by the old key is rejected; the user must
     re-activate to get a new-key signature.

### Step 4 — Notify affected customers with new license keys

1. **Identify affected customers** from the revocation list query in Step 2.

2. **Generate new license keys** for each affected license. The new keys are
   associated with the same License row (or a new License row if the original
   is revoked) and signed with the new key.

3. **Send a notification email** to each affected customer via Brevo:
   - Subject: `Action required: Your LyraShield license key has been rotated`
   - Body: Explain that a security incident required key rotation, provide the
     new license key and link to re-activation instructions.
   - Do NOT include the license file in the email — the user must re-activate
     to receive a freshly signed file.

4. **Log all re-issued keys** in the audit log for post-incident review.

### Step 5 — Post-incident review

1. **Document the timeline:** when the compromise was detected, when each step
   was executed and when the overlap window closed.

2. **Conduct a root-cause analysis:** how was the key exposed? Was it an
   insider, a misconfiguration, a CI/CD leak or a Key Vault access control
   failure?

3. **Update access controls:**
   - Restrict Key Vault access to the minimum necessary principals.
   - Enable Key Vault firewall and private endpoints if not already enabled.
   - Review CI/CD pipelines for any path that could expose the key.

4. **Verify remediation:**
   - Confirm no licenses signed by the old key are accepted by the latest
     desktop client.
   - Confirm the revocation list is complete and bundled.
   - Confirm all affected customers have been notified and re-activated.

5. **File an incident report** in the LyraShield documentation system with
   the timeline, root cause and remediation steps. Notify the founder.

### Quick reference

| Step | Action                                     | Owner                 | Target time |
| ---- | ------------------------------------------ | --------------------- | ----------- |
| 1    | Generate new keypair in Key Vault          | Founder / Azure admin | < 1 hour    |
| 2    | Ship update with new key + revocation list | Engineering           | < 24 hours  |
| 3    | Dual-sign during overlap window            | Engineering           | 30 days     |
| 4    | Notify affected customers                  | Founder / Support     | < 48 hours  |
| 5    | Post-incident review                       | Founder               | < 7 days    |

## Trial claim backfill

`packages/db/scripts/backfill-clear-wrong-trial-claims.ts` clears wrongly stamped `User.trialStartedAt` rows left by the retired fallback that stamped the column for invited members who never received a trial grant.

A candidate is a user whose `trialStartedAt` is set while the account has neither trial marker row (`BillingAccount.provider = "trial"`, `accountId = user.id`) nor trial grant (`UsageRecord.kind = "trial_grant"`, `accountId = user.id`). A marker or grant of any age — even soft-deleted — means the claim was real and the user is skipped.

### Steps

1. Run a dry pass from the production worker VM and read the candidate list (ids and created dates only — never emails):

   ```bash
   sudo /usr/local/libexec/lyrashield-trial-claim-backfill
   ```

2. Review the `candidates` array. Apply with the explicit confirmation flag:

   ```bash
   sudo /usr/local/libexec/lyrashield-trial-claim-backfill --apply=backfill-clear-wrong-trial-claims
   ```

   The VM runner rejects a bare `--apply`; use the pinned confirmation spelling so the intent remains explicit in runbooks and shell history.

3. The apply pass runs in one serializable transaction: each candidate's `trialStartedAt` is cleared and one chained `AuditLog` row (`trial.claim_cleared`, `resourceType: "user"`) is appended in the user's oldest owned workspace. A cleared user who owns no workspace is listed under `unaudited`.

4. Re-run the dry pass — the candidate list should be empty. The script is idempotent.

### Production execution

Production execution is a founder action run from the worker VM — never from a laptop and never under the runtime role. The runner creates a one-shot container from the deployed digest, passes only the system database URL through a private temporary environment file, and copies the image-bound reviewed script into the deployed database package. It accepts only a dry run or the exact apply confirmation shown above. Retain the printed report as the receipt.

## Affiliate payout operations

This section retains the approved payout operating model and the unresolved provider and tax gates. It is an internal execution checklist, not legal or tax advice. Current provider requirements and Indian tax treatment must be confirmed with the paying entity's authorized dealer bank and qualified tax adviser before production payouts.

### Approved operating model

- The paying entity is the Indian company. Polar collects payments only and does not pay affiliates.
- India affiliate payouts use RazorpayX in INR.
- Non-India affiliate payouts use Payoneer Enterprise Mass Payouts, subject to partnership and API approval. BriskPe or Cashfree is the fallback if the primary rail is unavailable or unsuitable.
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
