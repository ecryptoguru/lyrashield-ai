# Experiment registry

Minimal record of conversion/retention experiments. One entry per change;
survives until the Wave F experiment framework exists. Measurement is
sequential (before/after) unless a flag mechanism is added.

## EXP-001 — Hero task-oriented CTAs

- **Status:** merged in PR #677 (`9cde77d2`) and deployed in production release `34842662910`; measured outcome pending (in-place; no flag)
- **Surface:** `apps/marketing/src/components/landing/PremiumHero.astro`
- **Hypothesis:** task-oriented CTAs ("Review my app" + secondary "Try free
  Lite Check") convert to `account_created` and `first_run_started` better than
  the account-oriented "Create account" + text links.
- **Change:** primary `Review my app` (`cta=review_app`,
  `cta_id=premium-hero-review-app`); Lite Check promoted to secondary button
  (`cta_id=premium-hero-lite-check`); agent setup stays a text link; trial
  note reworded to honest scope; artifact card now a labeled `Example` with
  `Detected` state (also a claims-policy fix).
- **Primary metric:** durable attributed account creation per landing view
  over a declared 30-day attribution window; `account_created` is email-only
  and cannot measure OAuth completions. Secondary: lite-check starts
  (`scan_started`), agent-page CTR. Marketing and app anonymous device IDs are
  not assumed to join across origins.
- **Comparison:** sequential vs prior `premium-hero-create-account` window.
- **Decision rule:** keep if durable attributed account creation per landing_view does not regress
  and first-run activation rises; revisit if lite-check cannibalization drops
  signups >15% without activation gain.

## Queue

- Lite-check → signup deep link (`from=scan&target=url` preselect) — shipped
  with the context-preservation work; measure via `signup_started{target_type=url}`.
