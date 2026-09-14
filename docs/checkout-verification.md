# Live checkout verification runbook

> **Founder-controlled.** This runbook turns on real money. Stop conditions are
> explicit — nothing here runs unattended.

## Current state (read back 2026-09-14)

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

## Step 0 — preflight (safe, read-only)

```bash
pnpm --filter @lyrashield/worker verify:checkout-readiness
```

Validates admission posture, provider credentials, and catalog completeness
(plan × interval + pack + local keys). Exits non-zero on gaps. This is a
config check, not a payment test.

## Step 1 — canary admission

1. If moving Cloud admission from its current `public` posture to `canary`,
   record the founder-approved workspace IDs in `BILLING_CANARY_WORKSPACE_IDS`.
   The protected `Configure Cloud billing admission` workflow changes **both**
   Polar and Razorpay Cloud flags together. Record both resulting values; do
   not assume this workflow can change one provider alone.
2. Redeploy web through the protected release path and read back the revision,
   traffic, flags, and allowlist before purchase.
3. With an authenticated billing manager session and valid Origin header,
   send `POST /billing/checkout` with JSON `workspaceId`, `plan`, and
   `interval`. An excluded workspace must receive external HTTP 503
   `PAYMENTS_UNAVAILABLE`; the internal decision reason is `not_canary`.
   Check the founder workspace can proceed without completing payment.
4. Re-run preflight; confirm `admission_posture` shows `canary` + ids set.

## Step 2 — live purchase (founder, real card)

Use the founder canary account. Purchase the **cheapest self-serve paid plan**
(STARTER monthly, $29) — never test with LAUNCH_ASSURANCE first.

Evidence to retain per purchase:

- Provider dashboard receipt (hosted checkout session id).
- `WebhookEvent` row: provider, event type, external id, `processed`, and
  `processedAt`; inspect related `WebhookEventTrack` rows for billing status,
  attempts, and completion. Retain provider signature-verification evidence
  from the webhook handling path. Do not copy the stored raw payload.
- `BillingAccount` row: `status=active`, `currentPlan`, `currentPeriodEnd`,
  `externalId` — confirms entitlement landed via webhook, not the return URL.
- `UsageRecord` monthly grant row for the plan's agent-minutes.
- A repeat checkout attempt no longer hits `CHECKOUT_IN_PROGRESS` after the
  90-second Redis lock expires; there is no checkout-claim database row.
- Screenshot of `/dashboard/billing` post-webhook (success notice + plan).

Use privileged, read-only, account-bound queries when collecting application
receipts; parameterize the exact provider event and founder account IDs, and
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

## Step 3 — Razorpay rail

Repeat with `RAZORPAY_BILLING_ADMISSION=canary`, an INR method, and the INR
plan catalog. Note: hosted-checkout methods above INR 15,000 are unproven —
test the highest INR tier deliberately, not incidentally. Razorpay packs price
dynamically via `BILLING_USD_INR_RATE` — verify the paise amount on the
payment link before paying.

## Step 4 — public admission (founder decision)

Only after: live charge + webhook + entitlement + cancel + refund evidence is
retained for the chosen rail and `WebhookEventTrack` `dead_letter` count is 0.
The founder's platform-admin account is excluded from `active_paid_accounts`:
its entitlement must update, but that Growth card must not increment. A
separately approved non-admin canary is needed to verify aggregate inclusion.

Flip to `public` per provider. `canary` remains available as a kill-switch.

## Rollback

Set the affected `*_BILLING_ADMISSION` back to `off` and redeploy. Existing
subscriptions are unaffected — admission gates _new_ purchases only. Failed
tracks below the retry cap can reconcile; `dead_letter` tracks are terminal and
are **not** automatically re-enqueued. Check `admin → Billing`, retain event
and track IDs, diagnose provider delivery and processing without exposing raw
payloads, and use a separately authorized bounded recovery operation. Do not
mark a rail ready with unresolved dead letters.

## What this runbook does not cover

Payouts (RazorpayX/Payoneer), tax-form operations, marketplace listing
payments — separate founder workstreams with their own gates.
