# Growth measurement specification

Status: project `605869` connected; initial dashboard live. Assessment survey remains draft pending results-page deployment and verification.
Do not count checkout-return events as successful payment.
Use the existing single PostHog project, anonymous device IDs, DNT/GPC opt-out,
and the event/property allowlists in `apps/web/src/lib/analytics.ts` and
`apps/marketing/src/layouts/Base.astro`. Do not enable autocapture, session
recording, `identify()`, raw target URLs, or account IDs in client events.

## Event panels

| Panel                    | Numerator            | Denominator          | Breakdown             |
| ------------------------ | -------------------- | -------------------- | --------------------- |
| Marketing CTA engagement | `cta_click`          | `landing_view`       | allowlisted `cta_id`  |
| Lite check completion    | `scan_completed`     | `scan_started`       | no target identifiers |
| Signup start by method   | `signup_started`     | `signup_page_viewed` | `method`              |
| First-run start          | `first_run_started`  | `trial_started`      | `preset`              |
| Checkout return          | `checkout_completed` | `checkout_started`   | `provider`, `outcome` |

Use a 30-day window and display event counts and rates with the exact
denominator. Cross-origin anonymous IDs are not assumed to identify the same
person. The email-only `account_created` event is diagnostic, not the all-method
signup conversion numerator. The checkout-return panel reports browser flow
only; `outcome=success` is not payment or entitlement proof.

## Durable admin panels

Use server-derived `AccountAcquisition`/User and BillingAccount data for
all-method account creation, first valid assessment, active paid accounts,
30-day cancellations, MRR/ARR, and second-release retention. Exclude platform
administrators from paid-account aggregates, keep founder canary entitlement
verification separate, and label INR MRR as published USD catalog equivalent.
Do not copy account IDs or billing rows into PostHog. Configure any external
dashboard only after the code and migration are deployed and its data-source
permissions are reviewed.

## Optional assessment feedback

The project has a draft, one-time, two-question survey for completed
`/dashboard/scans/` results pages. Target the `#scan-results-ready` element,
which appears only when a scan completes. It asks for a usefulness rating
(1–5) and one improvement category. It has no
free-text answer, account linkage, target URL, or finding detail. Keep it draft
until the shared project key, privacy notice, and results-page selector are
deployed and read back. DNT/GPC browsers must not initialize PostHog or see the
prompt. Survey responses are feedback, not independent finding verification.
