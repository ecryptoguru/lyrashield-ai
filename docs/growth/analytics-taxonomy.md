# Funnel event taxonomy

Single PostHog project, two surfaces. **Anonymous only** — no `identify()`.
Durable funnel truth (activation, paid accounts, second release) lives in
admin metrics derived from Postgres (`platform-admin-overview` /
`growth-metrics`), not in events.

Client events pass through a strict allowlist + property denylist
(`apps/web/src/lib/analytics.ts`); marketing captures pass through the
per-event allowlist and property denylist in
`apps/marketing/src/lib/posthog-privacy.ts`. DNT/GPC prevents SDK
initialization on both surfaces. The app reduces URL metadata to origins and
drops pathname properties before capture so scan and target identifiers in
routes do not reach PostHog. Marketing strips query strings and fragments from
public page URLs and never sends target-derived properties.

## Handoff name → implemented name

| Funnel moment                | Web event                | Marketing event                            | Properties (allowlisted)                                 |
| ---------------------------- | ------------------------ | ------------------------------------------ | -------------------------------------------------------- |
| Landing view                 | —                        | `landing_view`                             | utm_source, utm_medium, utm_campaign, referrer_host      |
| CTA click                    | —                        | `cta_click`                                | cta_id                                                   |
| Lite check started           | —                        | `scan_started`                             | device, attribution                                      |
| Lite check completed         | —                        | `scan_completed`                           | duration_ms, finding_count, had_findings                 |
| Lite check failed            | —                        | `scan_blocked` / `scan_error`              | reason                                                   |
| Signup page viewed           | `signup_page_viewed`     | —                                          | source, cta, utm_*, landing_route, target_type           |
| Signup started               | `signup_started`         | —                                          | method + attribution props                               |
| Account created              | `account_created`        | —                                          | method + attribution props                               |
| Build context chosen         | `onboarding_context`     | —                                          | tool                                                     |
| Path chosen                  | `onboarding_path_chosen` | —                                          | path                                                     |
| GitHub connect started       | `github_connect_started` | —                                          | —                                                        |
| Repos loaded                 | `repos_loaded`           | —                                          | repo_count_bucket, load_ms_bucket                        |
| Repos selected               | `repos_selected`         | —                                          | selected_count                                           |
| Trial started                | `trial_started`          | —                                          | surface                                                  |
| First run started            | `first_run_started`      | —                                          | preset, asset_count, estimate_low_min, estimate_high_min |
| Review completed             | `review_completed`       | —                                          | status                                                   |
| Results viewed               | `results_viewed`         | —                                          | status, had_findings                                     |
| Report created               | `report_created`         | —                                          | report_kind                                              |
| Billing opened               | `billing_opened`         | —                                          | plan, trial_active                                       |
| Upgrade clicked              | `upgrade_clicked`        | —                                          | plan, interval                                           |
| Checkout started             | `checkout_started`       | —                                          | plan, interval                                           |
| Checkout return              | `checkout_returned`      | —                                          | provider, outcome (success\|processing\|cancelled)       |
| Share created                | `share_created`          | —                                          | variant, channel                                         |
| Scorecard (lite)             | —                        | `scorecard_generated` / `scorecard_shared` | referral_code present/absent, channel                    |
| Waitlist join (lite)         | —                        | `waitlist_joined`                          | source                                                   |
| Referral visit/signup (lite) | —                        | `referral_visit` / `referral_signup`       | source                                                   |
| Notification opened          | `notification_opened`    | —                                          | event_type                                               |
| FAQ open                     | —                        | `faq_open`                                 | question_id                                              |

## Server-truth metrics (not events)

| Metric                                    | Source                                                   | Surface             |
| ----------------------------------------- | -------------------------------------------------------- | ------------------- |
| Activation rate                           | Scan/user tables                                         | admin overview      |
| Time to first valid assessment            | Scan/user tables                                         | admin overview      |
| Setup abandonment                         | AuditLog + users                                         | admin overview      |
| Connection success                        | AuditLog                                                 | admin overview      |
| Recovery success                          | agent_operations                                         | admin overview      |
| Second release (repeat assessment 7d/28d) | Scan table                                               | admin overview      |
| **active_paid_accounts**                  | BillingAccount (provider, status, plan, admin exclusion) | admin overview (A3) |
| subscription_activated / canceled         | BillingAccount + WebhookEvent                            | admin overview (A3) |
| MRR / ARR                                 | BillingAccount × CLOUD_PLAN_MAP                          | admin overview (A3) |

## Metric dictionary and limits

| Metric                 | Source and meaning                                                                                      | Limit                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signup starts          | `signup_started` browser event                                                                          | Anonymous and incomplete when analytics is opted out, blocked or lost across browser/device boundaries; not the authoritative account-created count.                                                      |
| First accepted scan    | `Scan` rows after the existing admission path accepts a request                                         | A click or attempted request is not acceptance; no paid replay is used to improve the metric.                                                                                                             |
| Time to first scan     | Account creation to first accepted `Scan`, from existing operational data                               | Do not join anonymous PostHog IDs to private account identities.                                                                                                                                          |
| Completion / failure   | Terminal `Scan` states, split by profile and stated target scope                                        | Completion is not proof of universal coverage, a verified finding or release safety.                                                                                                                      |
| Usable evidence        | Existing manifest, receipt, coverage and expiry rules                                                   | Keep incomplete and not-applicable separate; do not infer from scan status alone.                                                                                                                         |
| Fix / retest progress  | Fix proposals plus trusted retest and verification receipts                                             | Proposed, applied, retest-confirmed and independently verified are distinct states.                                                                                                                       |
| Share intent           | `share_created` after explicit share creation                                                           | Channel open is not external publication, impression or reach.                                                                                                                                            |
| Referral conversion    | Persisted first-touch attribution plus the qualifying reward state                                      | A click is not a signup; pending is not rewarded.                                                                                                                                                         |
| Checkout return        | `checkout_returned` with provider and browser-return outcome                                            | The query string records a browser return only. It is not a payment, entitlement, settlement or revenue event. Historical `checkout_completed` rows keep their original meaning and are not reclassified. |
| Active paid accounts   | Provider-backed, active, non-FREE BillingAccount rows, deduped by account and excluding platform admins | Exclude trials and complimentary access; account is the denominator, not workspace.                                                                                                                       |
| MRR / ARR              | Current paid account rows × published USD catalog; annual amounts divided by 12                         | A catalog-equivalent reporting convention, not cash settlement, tax revenue or INR FX accounting.                                                                                                         |
| Cancellations          | Account-deduped provider-backed cancellation count in the last 30 days                                  | A count without a starting cohort or denominator is not a churn rate.                                                                                                                                     |
| Customer feedback      | Existing optional usefulness assessment                                                                 | Feedback is not NPS and does not independently verify findings.                                                                                                                                           |
| CAC / churn rate / NPS | Not established by the reviewed sources                                                                 | Omit or display unavailable; do not fabricate values or add unrequested survey/spend ingestion.                                                                                                           |

Use the existing single PostHog project and durable database metrics. Keep anonymous events separate from account-owned billing and scan records; do not add raw user, account, workspace or target identifiers to browser events.

## Never in events

Source code, secrets, private URLs, target coordinates, credentials, finding
detail/severity/CWE, model costs, raw referrer query strings, IP/user-agent.
`FORBIDDEN_PROPERTY_KEYS` enforces this regardless of allowlist membership.

## Privacy notes

- PostHog `distinct_id` remains the anonymous device id; account association
  is a deliberate policy decision (founder, 2026-09-14: stay anonymous).
- Attribution params are sanitized to bounded tokens; `landing_route` is an
  enum of public route names, never a raw URL.
