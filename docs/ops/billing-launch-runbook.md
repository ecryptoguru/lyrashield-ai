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

## Provider environment and deployment contract

`POLAR_ENVIRONMENT` must be exactly `sandbox` or `production` whenever
`POLAR_ACCESS_TOKEN` is configured. The value is passed to the Polar SDK as its
explicit server selector; the application never relies on the SDK's implicit
production default. Razorpay selects Test Mode or Live Mode through the
credential pair itself, so test verification must require an `rzp_test_` key ID.

The Azure deployment binds provider secrets and catalog maps from the protected
GitHub environment into the app Container App. It fails before revision creation
when any credential, webhook secret, organization ID, catalog map, or explicit
Polar environment is absent or malformed. Billing credentials are not copied to
the Lite Scanner Container App. Every deployment writes all four purchase
admissions as `off` and clears the canary workspace list; later admission is a
separate founder-reviewed configuration change.

Required protected-environment configuration:

- Variables: `POLAR_ENVIRONMENT`, `POLAR_ORG_ID`, `POLAR_PRODUCT_IDS`,
  `POLAR_LOCAL_PRODUCT_IDS`, and `RAZORPAY_PLAN_IDS`.
- Secrets: `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`.

Do not mix Sandbox/Test values with production catalog IDs or webhook endpoints.
Changing `POLAR_ENVIRONMENT` without rotating the whole Polar credential and
catalog set fails review even when checkout admission is off.

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

Run the checked-in Playwright billing suite only against a disposable database,
verified OWNER session, and disposable workspace. Set
`BILLING_E2E_STORAGE_STATE`, `BILLING_E2E_WORKSPACE_ID`, and the provider-specific
test-mode flag. Polar additionally requires `POLAR_ENVIRONMENT=sandbox`;
Razorpay requires an `rzp_test_` key ID. The suite supplies `workspaceId`, rejects
client region overrides, signs raw webhook bodies, and checks durable replay
effects. Hosted-checkout payment-method availability still needs a Brave receipt
because Razorpay owns that UI.

Live-mode inspection may confirm KYC, settlement, catalog, webhooks, and payment
methods. It must not submit payment details, accept new financial terms, change
admission, or be described as a successful live charge.
