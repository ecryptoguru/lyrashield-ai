# Billing launch runbook

## Admission contract

Checkout admission is server-controlled after geographic provider selection:

- `POLAR_BILLING_ADMISSION=off|canary|public`
- `RAZORPAY_BILLING_ADMISSION=off|canary|public`
- `BILLING_CANARY_WORKSPACE_IDS=<comma-separated workspace IDs>`

Production defaults both providers to `off`. `off` returns a stable unavailable
response without contacting the provider. `canary` permits only an exact,
authenticated workspace ID from the validated allowlist. `public` permits the
normal authenticated, workspace-scoped flow. A malformed canary allowlist fails
closed. Clients cannot select a provider or override admission.

Admission gates new Cloud subscription and minute-pack checkout requests only.
Webhook processing stays enabled in every mode so existing subscriptions,
refunds, and delayed events can settle. Never infer test or live mode from a
token prefix.

The repository does not yet expose a first-party Local-license checkout route.
Until one is added and reviewed, any Polar Local production canary must be
created through the provider's controlled purchase surface, kept unshared, and
reconciled against the existing webhook/license fulfillment path. Do not call
Local self-service public.

## Pre-canary gate

- [ ] Production provider catalog IDs, prices, tax behavior, refund copy,
      customer URLs, webhook destination, and rotated secrets are verified.
- [ ] One founder-owned workspace is allowlisted; no customer workspace is
      present.
- [ ] Provider mode is `canary`; the other provider remains `off`.
- [ ] Checkout rate limits, workspace authorization, unavailable UI, webhook
      signature verification, idempotency, and audit logging pass.
- [ ] Queue/readiness, provider, entitlement, metering, email, and reconciliation
      alerts have an owner.
- [ ] Founder approved the exact charge and non-refundable Local purchase.

Maximum planned canary charges, excluding tax and foreign-exchange effects:

- Polar Cloud Starter: USD 29 monthly.
- Polar Local Individual Launch: USD 199, non-refundable.
- Razorpay Cloud Starter: INR 2,900 monthly.

## Polar

1. Keep Razorpay `off`. Set Polar to `canary` with one founder workspace.
2. Complete one USD 29 Cloud Starter purchase and one controlled USD 199 Local
   purchase without referral or affiliate attribution.
3. Verify exactly one persisted and processed `WebhookEvent`, active
   `BillingAccount`, 300-minute grant, metering debit, Local license/key pair,
   license email, Key Vault signature, machine binding, and audit trail.
4. Replay the signed webhook and verify it creates no second entitlement.
5. Observe alerts, logs, reconciliation, queue readiness, and customer state for
   24 hours. Cancel the Cloud canary before renewal; keep the founder Local
   license and do not request a test-only refund.
6. Remove the canary workspace from the allowlist, then explicitly set Polar to
   `public` only if every check passes.

## Razorpay

1. Keep Polar in its independently approved mode. Set Razorpay to `canary` with
   a separate India founder workspace.
2. Complete one INR 2,900 Starter monthly purchase.
3. Verify the subscription, one 300-minute grant, one metering debit, webhook
   idempotency, audit log, billing UI, and provider reconciliation.
4. Observe for 24 hours and cancel before renewal.
5. Remove the canary workspace, then explicitly set Razorpay to `public` only if
   its own evidence passes. Smoke-test both regional paths without another
   charge.

## Failure and rollback

Set only the failing provider to `off`. Keep webhooks enabled, preserve provider
and audit evidence, and do not blindly replay an ambiguous paid event. Reconcile
provider state, `WebhookEvent`, ledger grants/debits, licenses, and customer UI
before retrying. Polar approval never opens Razorpay.

Record provider mode changes, workspace allowlist hashes, purchase/event IDs,
amounts, timestamps, idempotency results, entitlement and metering rows, alert
window, reconciliation result, cancellation, operator, and founder approval.
