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

Catalog-map values accept either a single provider ID or a current-first array
such as `{"pro_monthly":["current-id","legacy-id"]}`. New checkouts use the
first ID. Retain immutable legacy IDs for as long as an existing subscription,
pending checkout, delayed webhook, refund, or reconciliation record can refer
to them. A missing or malformed map is a retryable server configuration failure,
not a malformed-provider-payload response.

Do not mix Sandbox/Test values with production catalog IDs or webhook endpoints.
Changing `POLAR_ENVIRONMENT` without rotating the whole Polar credential and
catalog set fails review even when checkout admission is off.

The isolated Azure billing-staging resources use a private database and are not
deployed through the production workflow. Do not reuse production Azure
credentials or resource variables for staging. A future declarative deployment
must first have a protected staging-only Azure identity and must run migrations
from inside the staging VNet (for example, as a one-shot Container Apps job);
GitHub-hosted runners cannot directly migrate the private database.

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
Entitlement-bearing events must also prove that the provider-owned product or
plan ID resolves through the configured catalog map. Polar one-time packs and
Local purchases use exact pre-discount/pre-tax `subtotal_amount`; recurring plan
events use their immutable provider product ID and matching plan metadata so a
legitimate discount, tax, proration, or legacy price does not fail fulfillment.
Razorpay pack and Local Payment Links carry an HMAC-protected server quote over
provider, purchase kind, workspace/reference, catalog key, integer minor-unit
amount, and currency. Fulfillment requires a valid quote and exact paid amount,
so a later FX/catalog change cannot upgrade or reject a pending purchase.
`payment_link.paid` validates but never credits a minute pack; the independently
signed `payment.captured` event is the sole pack-credit authority. Razorpay
subscription renewals use immutable plan ID plus matching plan metadata and do
not compare against today's catalog price. Signed metadata without the provider
ID or server-origin quote required for its purchase kind is never authority.
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

The current suite can provision its own unique verified OWNER and VIEWER,
in-memory session states, workspace, and policy. It refuses the production
LyraShield AI origins and will not mutate until all of the following agree:

- `BILLING_E2E_DISPOSABLE_CONFIRM="DELETE DISPOSABLE BILLING DATA"`;
- `BILLING_E2E_EXPECTED_DATABASE` equals PostgreSQL `current_database()`;
- `BILLING_E2E_EXPECTED_DATABASE_HOST` equals the host in both database URLs;
- `BILLING_E2E_EXPECTED_BASE_HOST` exactly equals the browser origin host;
- remote origins additionally set `LYRASHIELD_E2E_BASE_URL` and
  `BILLING_E2E_ALLOW_REMOTE=1`.

Use `BILLING_E2E_ACCESS_HEADER_NAME` and `BILLING_E2E_ACCESS_HEADER_VALUE` only
for the restricted staging access gateway. The header is applied in memory and
is not persisted in browser storage state; Playwright trace capture is disabled
while it is configured because traces can persist request headers. The fixture deletes the VIEWER first
and then uses the RLS-safe account-deletion path to remove the OWNER and its
workspace. License tests separately delete their exact issued license because
license workspace deletion intentionally uses `SET NULL`.

Run Polar and Razorpay separately or together:

```sh
pnpm exec playwright test e2e/billing/checkout-flows.spec.ts --project=chromium
pnpm exec playwright test e2e/billing/razorpay-upi-cap-fallback.spec.ts --project=chromium
pnpm exec playwright test e2e/billing --project=chromium
```

Set `BILLING_E2E_LOCAL_MODE=1` only when Local admission is deliberately
`public` in the isolated provider environment and test email delivery plus the
Ed25519 signing configuration are working. The suite otherwise skips Local
license fulfillment rather than weakening production delivery behavior.
Razorpay Test subscriptions created by the matrix are canceled in teardown.
Provider-hosted Sandbox checkout sessions and payment links are not charges and
may remain visible until provider expiry; record and prune them under the
provider's test-data retention procedure when the dashboard offers no supported
cancel operation.

Live-mode inspection may confirm KYC, settlement, catalog, webhooks, and payment
methods. It must not submit payment details, accept new financial terms, change
admission, or be described as a successful live charge.
