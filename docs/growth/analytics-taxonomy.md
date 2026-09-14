# Funnel event taxonomy

Single PostHog project, two surfaces. **Anonymous only** — no `identify()`.
Durable funnel truth (activation, paid accounts, second release) lives in
admin metrics derived from Postgres (`platform-admin-overview` /
`growth-metrics`), not in events.

Client events pass through a strict allowlist + property denylist
(`apps/web/src/lib/analytics.ts`); marketing events are hand-rolled captures
in `Base.astro` / `scan.astro`. DNT/GPC prevents SDK initialization on both
surfaces. The app reduces URL metadata to origins and drops pathname properties
before capture so scan and target identifiers in routes do not reach PostHog.
Marketing strips query strings and fragments from public page URLs.

## Handoff name → implemented name

| Funnel moment                | Web event                | Marketing event                            | Properties (allowlisted)                                     |
| ---------------------------- | ------------------------ | ------------------------------------------ | ------------------------------------------------------------ |
| Landing view                 | —                        | `landing_view`                             | utm_source, utm_medium, utm_campaign, referrer_host          |
| CTA click                    | —                        | `cta_click`                                | cta_id                                                       |
| Lite check started           | —                        | `scan_started`                             | target_domain_hash, device, attribution                      |
| Lite check completed         | —                        | `scan_completed`                           | duration_ms, finding_count, categories_flagged, had_findings |
| Lite check failed            | —                        | `scan_blocked` / `scan_error`              | reason                                                       |
| Signup page viewed           | `signup_page_viewed`     | —                                          | source, cta, utm_*, landing_route, target_type               |
| Signup started               | `signup_started`         | —                                          | method + attribution props                                   |
| Account created              | `account_created`        | —                                          | method + attribution props                                   |
| Build context chosen         | `onboarding_context`     | —                                          | tool                                                         |
| Path chosen                  | `onboarding_path_chosen` | —                                          | path                                                         |
| GitHub connect started       | `github_connect_started` | —                                          | —                                                            |
| Repos loaded                 | `repos_loaded`           | —                                          | repo_count_bucket, load_ms_bucket                            |
| Repos selected               | `repos_selected`         | —                                          | selected_count                                               |
| Trial started                | `trial_started`          | —                                          | surface                                                      |
| First run started            | `first_run_started`      | —                                          | preset, asset_count, estimate_low_min, estimate_high_min     |
| Review completed             | `review_completed`       | —                                          | status                                                       |
| Results viewed               | `results_viewed`         | —                                          | status, had_findings                                         |
| Report created               | `report_created`         | —                                          | report_kind                                                  |
| Billing opened               | `billing_opened`         | —                                          | plan, trial_active                                           |
| Upgrade clicked              | `upgrade_clicked`        | —                                          | plan, interval                                               |
| Checkout started             | `checkout_started`       | —                                          | plan, interval                                               |
| Checkout return              | `checkout_completed`     | —                                          | provider, outcome (success\|processing)                      |
| Share created                | `share_created`          | —                                          | variant, channel                                             |
| Scorecard (lite)             | —                        | `scorecard_generated` / `scorecard_shared` | referral_code present/absent, channel                        |
| Waitlist join (lite)         | —                        | `waitlist_joined`                          | source                                                       |
| Referral visit/signup (lite) | —                        | `referral_visit` / `referral_signup`       | source                                                       |
| Notification opened          | `notification_opened`    | —                                          | event_type                                                   |
| FAQ open                     | —                        | `faq_open`                                 | question_id                                                  |

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

## Never in events

Source code, secrets, private URLs, target coordinates, credentials, finding
detail/severity/CWE, model costs, raw referrer query strings, IP/user-agent.
`FORBIDDEN_PROPERTY_KEYS` enforces this regardless of allowlist membership.

## Privacy notes

- PostHog `distinct_id` remains the anonymous device id; account association
  is a deliberate policy decision (founder, 2026-09-14: stay anonymous).
- Attribution params are sanitized to bounded tokens; `landing_route` is an
  enum of public route names, never a raw URL.
