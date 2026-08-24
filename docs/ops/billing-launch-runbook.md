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

The isolated Azure billing-staging resources use a private database and the
protected `billing-staging` GitHub environment. They are deployed only by
`.github/workflows/deploy-billing-staging.yml`; never reuse production Azure
credentials, resource variables, databases, Redis, registry, or provider
credentials. The workflow checks out the dispatched `main` SHA, builds and
pushes both `runner` and `workspace-builder` targets to the isolated staging
ACR under that exact SHA, captures their immutable digests, verifies their OCI
revision labels, and deploys by digest. Operators do not supply image digests.

Private-database migrations and role provisioning run inside the staging VNet
as disposable Container Apps Jobs. Their commands are image-owned executable
paths with no shell `-c`, interpolated command, or `--args`; the workflow always
deletes the one-shot jobs after Azure login. The web runtime receives the
RLS-bound `app_runtime_staging` URL as `DATABASE_URL` and the separately built
`app_system_staging` URL as `DATABASE_SYSTEM_URL`. The latter is
`NOSUPERUSER`, `NOBYPASSRLS`, `NOREPLICATION`, has no role memberships, and has
only SELECT/INSERT/UPDATE on `License`, `LicenseKey`, and `LicenseActivation`
plus DELETE on `License` for exact disposable-test cleanup. The PostgreSQL admin
URL exists only as a masked job secret and is never bound to the web app.

External Container Apps ingress remains available for sandbox/test provider
webhooks, but the application proxy returns 404 for every ordinary route until
the operator submits the access code through `/staging/access`. A successful
same-origin form POST creates an eight-hour `Secure`, `HttpOnly`, `SameSite=Lax`,
host-only cookie containing an opaque digest, not the access code. Only the
access bootstrap, `/_next/static/` assets, signed `/billing/webhook`, and exact
health/readiness paths are public. The webhook route still rejects missing or
invalid provider signatures. Do not put the access code in a URL, browser-wide
header, trace, screenshot, log, or provider navigation.

`BILLING_STAGING_ADMISSION=restricted` is accepted only with
`LYRASHIELD_DEPLOYMENT_ENVIRONMENT=billing-staging`, the isolated Azure origin,
Polar Sandbox, a Razorpay Test key, all four production purchase admissions
`off`, and a 32-character access token. Production deploys explicitly write the
deployment marker as `production`, staging admission as `off`, the staging
token empty, and all Cloud/Local admissions `off`. This staging exception does
not add a production canary or enable live billing.

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
verified OWNER session, and disposable workspace. Set the provider-specific
test-mode flag. Polar additionally requires `POLAR_ENVIRONMENT=sandbox`;
Razorpay requires an `rzp_test_` key ID. The suite supplies `workspaceId`,
rejects client region overrides, signs raw webhook bodies, and checks durable
replay effects. Hosted-checkout payment-method availability still needs a Brave
receipt because Razorpay owns that UI.

The current suite can provision its own unique verified OWNER and VIEWER,
in-memory session states, workspace, and policy. It refuses the production
LyraShield AI origins and will not mutate until all of the following agree:

- `BILLING_E2E_DISPOSABLE_CONFIRM="DELETE DISPOSABLE BILLING DATA"`;
- `BILLING_E2E_EXPECTED_DATABASE` equals PostgreSQL `current_database()`;
- `BILLING_E2E_EXPECTED_DATABASE_HOST` equals the host in both database URLs;
- `BILLING_E2E_EXPECTED_BASE_HOST` exactly equals the browser origin host;
- remote origins additionally set `LYRASHIELD_E2E_BASE_URL` and
  `BILLING_E2E_ALLOW_REMOTE=1`.

Set `BILLING_E2E_STAGING_ACCESS_TOKEN` only for restricted staging. The fixture
opens the real `/staging/access` page, fills the password field, and retains the
resulting HttpOnly cookie in browser storage state. It never installs a global
secret header, and trace capture is disabled while the token is present because
traces can retain form values. The fixture deletes the VIEWER first and then
uses the RLS-safe account-deletion path to remove the OWNER and its workspace.
License tests separately delete their exact issued license because license
workspace deletion intentionally uses `SET NULL`.

Run Polar and Razorpay separately or together:

```sh
pnpm exec playwright test e2e/billing/checkout-flows.spec.ts --project=chromium
pnpm exec playwright test e2e/billing/razorpay-upi-cap-fallback.spec.ts --project=chromium
pnpm exec playwright test e2e/billing --project=chromium
```

Set `BILLING_E2E_LOCAL_MODE=1` only through restricted billing staging with
test email delivery and Ed25519 signing operational. The four normal purchase
admissions must remain `off`. The suite otherwise skips Local license
fulfillment rather than weakening production delivery behavior.
Razorpay Test subscriptions created by the matrix are canceled in teardown.
Provider-hosted Sandbox checkout sessions and payment links are not charges and
may remain visible until provider expiry; record and prune them under the
provider's test-data retention procedure when the dashboard offers no supported
cancel operation.

Live-mode inspection may confirm KYC, settlement, catalog, webhooks, and payment
methods. It must not submit payment details, accept new financial terms, change
admission, or be described as a successful live charge.

The checked-in workflow, tests, and runbook establish a code contract only.
Until the protected staging workflow and real browser/provider flows run and
their redacted receipts are retained, hosted checkout and license staging proof
remain unverified. Sandbox/Test proof is never a live charge or authorization
to enable production admission.
