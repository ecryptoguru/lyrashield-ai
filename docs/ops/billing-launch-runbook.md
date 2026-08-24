# Billing and payout launch runbook

## Admission controls

All rails fail closed. Production changes require founder approval and an
audited configuration change.

- Cloud checkout: `POLAR_BILLING_ADMISSION` and
  `RAZORPAY_BILLING_ADMISSION` (`off`, `canary`, or `public`) plus exact
  `BILLING_CANARY_WORKSPACE_IDS`.
- Local checkout: `POLAR_LOCAL_BILLING_ADMISSION` and
  `RAZORPAY_LOCAL_BILLING_ADMISSION` (`off` or `public`).
- Affiliate payouts: `RAZORPAYX_PAYOUT_ADMISSION` (`off` or `public`).
  `PAYONEER_PAYOUT_ADMISSION` accepts only `off` until partnership API access,
  sandbox credentials, webhook contracts, and one sandbox payout are approved.

Admission gates new purchases and payouts only. Signed webhook processing,
existing subscription management, approved policy-exception reversals,
chargebacks, and reconciliation remain active. Set purchase and payout
admissions to `off` before rollback.

## Local purchase contract

`individual_launch` is the only purchasable Local SKU: USD 199 globally or INR
19,900 GST-inclusive in India. `/buy/local` shows the terms and calls
`POST /api/billing/local-checkout`; clients cannot select SKU, provider,
currency, or amount. Polar uses hosted one-time checkout. Razorpay uses a hosted
Payment Link with partial payment disabled. Browser callbacks report payment
receipt only. A signed, idempotent paid webhook is the sole license authority.

## Payout contract

RazorpayX methods store only provider fund-account IDs and masked display text.
Raw bank and tax documents do not belong in `Affiliate.payoutMethod`. A platform
operator must verify payout method and tax status. The scheduler sends paise,
the configured source account, fund-account ID, and `Payout.id` as
`X-Payout-Idempotency`.

Only provider state `processed` may finalize `PAID`. Queued, processing,
timeouts, and unknown responses remain `PROCESSING` for reconciliation. Only a
confirmed provider rejection releases reserved commissions. Never replay an
ambiguous payout.

## Required test-mode evidence

For each enabled purchase rail, retain signed request/event identifiers,
exactly one `WebhookEvent`, required track outcomes, entitlement or license
effect, GST split where applicable, commission outcome, and 100 replay results.
For RazorpayX, retain allowlisted-egress proof, idempotency response, provider
state transitions, reconciliation, and operator acknowledgement. Test evidence
does not authorize live charges or payouts.
