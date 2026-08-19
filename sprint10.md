# LyraShield — Sprint 10 Billing & Usage Metering: Dev-Ready Brief

Dev-ready brief for the LyraShield Developer Agent: Sprint 10 billing + usage metering + free-tier abuse controls. Exact plan definitions, Polar+Razorpay dual-gateway wiring, UsageRecord metering spec, entitlement gating, billing page, INR/GST/UPI, email-verification flip, and acceptance criteria. All numbers founder-confirmed 2026-08-06.

## Goal, Context & Constraints

- **Overage: $0.15/agent-min.** **Minute packs (valid 6 months): 100/$15 · 250/$30 · 500/$50** (volume discount $0.15/$0.12/$0.10). Starter/Pro buy packs; Team can buy packs and/or opt into metered overage + user-set spend limit.
- **Exhaustion grace (founder, 2026-08-16):** when a workspace's minute pool runs out **mid-scan**, do NOT hard-stop the scan — allow up to **15 minutes of free grace** for the in-flight scan to finish. If it finishes inside grace, unused grace evaporates (never banked); the workspace is then out of minutes and cannot start a new scan without buying minutes. If it does not finish within 15 min, stop it and surface "minutes + grace over." See the Grace Period section in Usage Metering Spec.
- **Refunds (Cloud):** **14-day money-back window** on Cloud subscriptions. (Local licenses are no-refund — separate brief.) Handle refund webhooks → reverse entitlement + claw back any affiliate commission.

## Existing Repo Surface (build on this)

## Existing Repo Surface — what already exists (verified from `packages/db/prisma/schema.prisma` + `.env.example`)

Build on this foundation; do not recreate it.

**Prisma schema (packages/db):**
- `Workspace.plan : WorkspacePlan` (default `FREE`) and `Workspace.billingStatus : String?`.
- `enum WorkspacePlan { FREE, PRO, TEAM, AGENCY, BUSINESS, ENTERPRISE }` — **no `STARTER`; add it (see Plan Definitions & Mapping).**
- `model BillingAccount { workspaceId @unique, provider @default("polar"), externalId?, status @default("free"), currentPlan @default(FREE), trialEndsAt? }`.
- `model UsageRecord { workspaceId, kind, quantity, metadata?, idempotencyKey String? @unique, createdAt }` — **`idempotencyKey` already exists (unique).** Use it for all metered/grant events; no schema change needed for it. Indexes present: `@@index([workspaceId])`, `@@index([kind])`, `@@index([workspaceId, createdAt])`.
- `model WebhookEvent { provider, eventType, externalId, payload, processed, processedAt, @@unique([provider, externalId]) }` — reuse for Polar/Razorpay webhook idempotency.

**Permissions / RBAC:** `BILLING_ADMIN` role and `billing:manage` permission exist in the RBAC matrix (packages/auth). Gate billing management behind these.

**Routes stubbed in PRD layout:** `billing/checkout/route.ts`, `billing/webhook/route.ts`, `billing/portal/route.ts` under the Next.js app (apps/web route handlers — there is no separate apps/api).

**Config/env:** `packages/config/src/env.ts` is the Zod env schema with boot-time fail-fast validation. Add billing vars here. `.env.example` already documents the four billing keys + `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION` (currently `"0"`, with the Brevo dependency documented).

**Deploy wiring:** `.github/workflows/deploy-azure.yml` injects secrets as `secretref:*` env vars on Azure Container Apps (pattern: `az containerapp secret set` per deploy). Add billing secrets following this exact pattern.

**Rate limiting / abuse:** Upstash REST distributed limiter present (`UPSTASH_REDIS_REST_URL/TOKEN`); falls back to in-memory. Scan creation is rate-limited per workspace.

**Usage/cost controls already enforced at scan level:** per-scan budget caps (Safe/Quick $1.20, Standard $3.20, Deep/Custom $15.00) and a `scan_cost_ledger` (migration `20260718110000`). The billing layer adds **aggregate per-tier monthly** control on top of the per-scan caps."}, {"name": "Usage Metering Spec (UsageRecord)", "content": "## Usage Metering Spec — protected targets + agent minutes\n\n### Use existing `UsageRecord`\n`UsageRecord` already has `idempotencyKey String? @unique` — **set it on every metered/grant event** so retried jobs/webhooks never double-bill or double-grant. Suggested `kind` values:\n- `agent_minute` — quantity in seconds (or ms); metadata: `{ scanId, mode, model, deep: bool, multiplier }`.\n- `protected_target` — one row per target-activation; metadata: `{ targetId }`.\n- `pool_grant` — periodic included-pool grant; metadata: `{ plan, periodStart, grantedMinutes, source: \"polar\"|\"razorpay\"|\"free\" }`.\n- `fix_pr` — one row per fix-PR consumed (enforces the FREE 1-fix-PR cap); metadata: `{ pullRequestId? }`.\n- `topup_purchase` / `overage_debit` — for paid minute packs / metered overage.\n\n### Agent-minute accounting\n- Meter **active agent-loop time** per scan, per second, aggregated to the workspace's current billing cycle. **Deep/Custom scans apply a 3× multiplier** before debiting the pool.\n- The worker already records engine usage/cost telemetry (see `Scan.durationMs`, token/cost fields); the billing layer consumes the **active-loop duration** signal (not wall-clock, not queue time). If active-vs-idle cannot be separated this sprint, bill wall-clock **and clearly mark the published definition as wall-clock** — do not silently bill idle.\n- Maintain a **per-workspace current-cycle balance**: included pool − consumed − topups − overage. Expose via an internal `getUsageBalance(workspaceId)`.\n\n### Protected-target accounting\n- Count active protected targets per workspace against the plan cap. Enforce at target-creation/activation time (not scan time).\n\n### Period rollover\n- On subscription cycle renewal (Polar/Razorpay webhook) or monthly cron for free tier, grant the new period's included pool as an idempotent `pool_grant` (idempotencyKey = `{workspaceId}:{periodStart}:{plan}`). Unused included minutes do **not** roll over (v1). Purchased top-up packs roll once (per plan policy — confirm).\n\n### Reconciliation\n- `UsageRecord` is the single source of truth for usage; reconcile to both Polar and Razorpay for billing events (webhook idempotency via existing `WebhookEvent` `@@unique([provider, externalId])`). Per-scan provider cost stays in the existing `scan_cost_ledger` (internal) — never expose cost/spend values on the dashboard."}

## Plan Definitions & Mapping

## Plan Definitions & Mapping

Define plans as data (a `plans.ts` in `packages/billing`), keyed to `WorkspacePlan`. Each plan declares: monthly + annual price (USD + INR), protected-target cap, agent-minute monthly pool, scan-depth allowance, feature gates, and sales motion.

**✅ Plan mapping — RESOLVED:** the live `WorkspacePlan` enum is `FREE, PRO, TEAM, AGENCY, BUSINESS, ENTERPRISE`. **Add `STARTER`** via an additive enum migration (`ALTER TYPE "WorkspacePlan" ADD VALUE 'STARTER'`; non-transactional, deployed before code references it). Mapping: self-serve checkout `STARTER→$29, PRO→$99, TEAM→$299`; contact-led top tier (from $499) maps to `AGENCY` (internal only, no checkout). `BUSINESS`/`ENTERPRISE` reserved for Phase 4.
> The `FREE` enum value now represents the **14-day trial state** (not a permanent free tier). See Trial section.

| Plan | Monthly (USD/INR) | Annual (USD/INR, prepaid) | Targets | Agent-min/mo | Scan depth | Sales motion |
|---|---|---|---|---|---|---|
| TRIAL (14-day) | $0 | — | 1–2 | **100** | **Standard/Quick only — NO Deep** | self-serve (sign up, no card) |
| STARTER | $29 / ₹2,900 | $295 / ₹29,500 (15% off) | 3 | **300** | **Standard only — NO Deep** | self-serve checkout |
| PRO | $99 / ₹9,900 | $950 / ₹95,000 (20% off) | 10 | **1,200** | Standard + **Deep** | self-serve checkout |
| TEAM | $299 / ₹29,900 | $2,690 / ₹2,69,000 (25% off) | 30 | **4,000** | Full (incl. Deep) | self-serve checkout |
| AGENCY / ENTERPRISE | **from $499** | custom | custom | custom | Full | **contact-led — no checkout** |

**Deep-scan gating (founder-confirmed 2026-08-15):** Deep/Custom scans are **Pro and above only** — **not** available on Trial or Starter. Enforce at scan creation (the scan-depth gate).

**Overage: $0.15/agent-min.** **Minute top-up packs (valid 12 months): 100/$15 · 250/$30 · 500/$50** (volume discount). Starter/Pro buy packs (prepaid); Team can buy packs and/or opt into metered overage + spend limit.

**Annual:** prepaid yearly per tier at the discounted rate; annual INR = annual USD × 100. Annual grants the **monthly agent-minute pool each month** (pool resets monthly; annual prepayment covers 12 months, not a lump-sum minute grant).

**Feature-gating principle (founder-confirmed):** gate by **capacity + collaboration + depth, never by core detection** — every tier gets real scans and verified findings. The trial is full-featured on Standard/Quick (the aha); Deep is the depth-gated paid feature (Pro+)."}, {"name": "Acceptance Criteria", "content": "## Acceptance Criteria (verify before claiming done)\n\n**Plans & schema**\n- [ ] `packages/billing` exists with plan definitions as data (3 self-serve tiers monthly+annual, minute packs, contact-led top tier, **14-day trial state**); `STARTER` added to `WorkspacePlan` via additive `ALTER TYPE ... ADD VALUE` migration (non-transactional, deployed before code that references it).\n- [ ] `UsageRecord.idempotencyKey` (already present, unique) is **set on every metered/grant event** — test proves retried webhook/job replays do not double-grant or double-debit.\n- [ ] All new env vars added to `packages/config/src/env.ts` (fail-fast), `.env.example`, and `turbo.json` `globalEnv`; billing secrets wired into `deploy-azure.yml` as `secretref:*`.\n\n**Dual gateway (self-serve tiers only)**\n- [ ] Polar: products for Starter/Pro/Team each with monthly + annual prices; one-time minute-pack products (100/$15, 250/$30, 500/$50); hosted checkout; customer portal; webhooks (`order.paid` idempotent pool grant + pack credit, subscription lifecycle) validated with `POLAR_WEBHOOK_SECRET`; webhook idempotency via `WebhookEvent @@unique([provider, externalId])`.\n- [ ] Razorpay: INR subscriptions monthly (₹2,900/₹9,900/₹29,900) + annual (₹29,500/₹95,000/₹2,69,000); UPI AutoPay with >₹15k fallback; one-time minute-pack payments; GSTIN capture + GST-compliant invoices; webhooks → same internal sync path as Polar.\n- [ ] Geo-IP routing selects Polar (USD) vs Razorpay (INR) with a manual override.\n- [ ] Agency/Enterprise $499 tier has **no checkout** — contact form only.\n\n**Trial**\n- [ ] 14-day no-card trial: **100 agent-min hard cap, Standard/Quick only (NO Deep)**, 1–2 target cap, email verification required, no auto-convert; expiry/limit → read-only/locked state + upgrade CTA.\n\n**Metering & gating**\n- [ ] Agent-minute metering records active-loop time, Deep at 3×, per-cycle balance correct; idempotent monthly pool grant (incl. annual subs granting monthly); included pool no rollover; **minute packs valid 12 months** with idempotent expiry debit; draw order = pool then oldest unexpired pack.\n- [ ] `assertScanAllowed`/`assertTargetAllowed`/`assertFixPrAllowed`/`getTrialState` enforced; **Deep/Custom blocked on Trial + Starter (Pro+ only)**; 80% warning + hard wall + upgrade CTA work.\n- [ ] Downgrade/cancel → read-only/limited state at period end, data retained, audit-logged.\n\n**UI**\n- [ ] Billing page shows plan/trial status/interval/usage (no $ cost values), unexpired pack minutes + expiry, portal link, upgrade/downgrade + monthly↔annual, minute-pack purchase, spend limit (Team).\n- [ ] Pricing page: **one page, Local/Cloud toggle**; Cloud view = 3 self-serve tiers with monthly/annual + USD/INR toggles, minute-pack add-on, \"Agency/Enterprise from $499\" contact-led line; trial CTA (no card); Deep clearly marked Pro+; confirmed copy; agent-minute definition + pack validity (12 months) + overage rate ($0.15/min) + no-refund policy published.\n\n**Email verification**\n- [ ] Brevo provisioned, secrets set, flag flipped to `\"1\"`, deploy green, verification enforced before trial opens publicly.\n\n**Quality gates**\n- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all green; Playwright E2E for trial signup → trial limit, Deep-blocked-on-trial/Starter, checkout (monthly + annual), minute-pack purchase, and gating happy paths.\n- [ ] No public benchmark/coverage/\"only-we\"/upstream-engine claims; **no money-back/refund claims** (no-refund policy).\n\n**Out of scope (defer):** enterprise SSO/SCIM/private workers build, proration edge cases, marketplace listings, self-serve checkout for the $499 tier, Local-mode license billing (separate Track B brief).\n\n**Process:** branch + PR (never push to main), verify green, merge only on explicit founder approval. Flag any plan-mapping or copy conflict back to the founder/marketing rather than guessing."}

## Free Trial (14-day, no card)

## Free Trial — 14 days, 100 min, no card, no Deep

The trial is the **only** free Cloud surface (no permanent free tier). It's the front door.

**Terms:**
- **14 days**, full-featured on **Standard/Quick** (real scans, findings, fix proposals, reports, MCP, GitHub Action, dashboard). **No credit card required.**
- **100 agent-minutes**, hard-capped (≈ $0.82 COGS at the corrected rate). Protected targets: small cap (1–2). **No Deep/Custom scans** (Deep is Pro+).
- **No auto-convert, no card on file** → no surprise charges. On trial end or cap, workspace → read-only/locked + clear upgrade CTA.

**Trial → paid conversion (full-feature on Standard/Quick; convert on limits + clock):**
- Lever = the **100-min / target cap + the 14-day clock**, plus **Deep scans** as the depth-gated Pro feature.
- The platform features (history, team, continuous monitoring, CI gating) are the reason to stay.
- Contextual upgrade prompts at trial midpoint, 80% minutes, 2nd-target attempt, a Deep-scan attempt (→ "Deep is a Pro feature"), and expiry. Honest, never dark-pattern.

**Trial abuse controls (no card on file):**
- **Email verification enforced** (Brevo flip) before trial use.
- 100-min hard cap, target cap, scan-frequency throttle, no Deep.
- Disposable-email / proxy / device-fingerprint signals flagged; one active trial per user/org.
- Existing Upstash rate limiting on scan creation stays on.

**Analytics:** `trial_started`, `trial_scan_completed`, `trial_limit_hit {kind}`, `trial_deep_blocked`, `trial_expired`, `trial_upgraded {plan}` (allowlisted, no PII/target/finding data).

## Usage Metering Spec (UsageRecord)

## Usage Metering Spec — protected targets + agent minutes

### Use existing `UsageRecord`
`UsageRecord` already has `idempotencyKey String? @unique` — **set it on every metered/grant event** so retried jobs/webhooks never double-bill or double-grant. Suggested `kind` values:
- `agent_minute` — quantity in seconds (or ms); metadata: `{ scanId, mode, model, deep: bool, multiplier }`.
- `protected_target` — one row per target-activation; metadata: `{ targetId }`.
- `pool_grant` — periodic included-pool grant; metadata: `{ plan, periodStart, grantedMinutes, interval: "month"|"year", source: "polar"|"razorpay"|"trial" }`.
- `fix_pr` — one row per fix-PR consumed; metadata: `{ pullRequestId? }`.
- `topup_purchase` — minute-pack credit; metadata: `{ packMinutes, provider, expiresAt }` (packs valid **6 months**).
- `topup_expiry` — debit when an unused pack expires at 6 months.
- `overage_debit` — metered overage (Team opt-in).
- `refund_reversal` — on a Cloud 14-day money-back refund, reverse the period pool + entitlement (idempotent).

### Agent-minute accounting
- Meter **active agent-loop time** per scan, per second, aggregated to the workspace's current billing cycle. **Deep/Custom scans apply a 3× multiplier** before debiting the pool (and Deep is Pro+ only — see gating).
- The worker already records engine usage/cost telemetry (see `Scan.durationMs`, token/cost fields); the billing layer consumes the **active-loop duration** signal (not wall-clock, not queue time). If active-vs-idle cannot be separated this sprint, bill wall-clock **and clearly mark the published definition as wall-clock** — do not silently bill idle.
- Maintain a **per-workspace current-cycle balance**: included pool + unexpired purchased packs − consumed − overage. Expose via `getUsageBalance(workspaceId)`. **Draw order: included pool first, then oldest unexpired pack.**

### Protected-target accounting
- Count active protected targets per workspace against the plan cap. Enforce at target-creation/activation time (not scan time).

### Period rollover & pack expiry
- On subscription renewal (Polar/Razorpay webhook) grant the new period's included pool as an idempotent `pool_grant` (idempotencyKey = `{workspaceId}:{periodStart}:{plan}`). For **annual** subscriptions, grant the monthly pool each month (pool resets monthly; annual prepayment covers 12 months, not a lump-sum minute grant). Unused included minutes do **not** roll over.
- **Purchased minute packs are valid 6 months** from purchase; a scheduled job expires unused pack minutes at `expiresAt` via a `topup_expiry` debit (idempotent).

### Reconciliation
- `UsageRecord` is the single source of truth for usage; reconcile to both Polar and Razorpay for billing events (webhook idempotency via existing `WebhookEvent @@unique([provider, externalId])`). Per-scan provider cost stays in the existing `scan_cost_ledger` (internal) — never expose cost/spend values on the dashboard.


### Exhaustion grace period (founder, 2026-08-16)

Supersedes a pure hard wall at pool exhaustion for the **in-flight** scan. The grace window is a per-workspace, per-cycle, non-accumulating allowance of free agent-minutes used only when the pool runs out mid-scan.

- **Trigger:** during a running scan, the per-cycle balance (pool + unexpired packs − consumed) crosses `<= 0`. New scans were already blocked at admission once balance `<= 0`; grace governs only the scan already in flight.
- **Behavior:** the in-flight scan continues, drawing from a bounded **`graceUsedMs`** counter (cap **15 min = 900,000 ms per cycle**, separate from the pool) instead of being killed immediately. Grace consumption is metered with the same active-loop signal and recorded as `agent_minute` UsageRecords with `metadata.grace: true` so it is auditable and never confused with paid pool draw.
- **Scan finishes inside grace (e.g. 5 min used):** debit the consumed grace, then **reset remaining grace to 0 for that cycle — unused grace is never banked or rolled over.** Workspace lands at balance `<= 0` → admission gate blocks new scans until top-up/upgrade. Surface "out of minutes (grace used)" + buy-minutes CTA.
- **Scan exceeds 15 min grace:** stop it (the worker's existing terminate/escalation path), persist partial usage, surface terminal status "minutes + grace period over" (map to the existing `STOPPED_BUDGET`-style out-of-minutes surface), and block new scans until minutes are purchased.
- **Non-negotiables:** grace is per-cycle and non-renewing without payment (prevents it becoming a free-tier loophole); it does NOT apply to a scan started when the balance was already `<= 0` (those are blocked at admission, never grace-eligible); the Deep 3x multiplier still applies to grace consumption.

## Billing Provider Wiring (Polar + Razorpay)

## Billing Provider Wiring — dual gateway (self-serve tiers only)

Dual gateway applies to the **three self-serve paid tiers (Starter $29 / Pro $99 / Team $299)** plus **one-time minute-pack purchases**. The **Agency/Enterprise $499 top tier is contact-led** — no checkout/product build; a contact form on the pricing page, founder provisions manually. (The 14-day trial has no checkout — no card required.)

### Polar (global MoR — default for non-India)
- Polar as merchant of record (handles sales tax/VAT).
- **Subscriptions:** one Polar product per self-serve tier (Starter/Pro/Team), each with a **monthly AND an annual price** (annual = prepaid, at the 15/20/25% discounted yearly rate).
- **One-time products:** minute packs (**100/$15, 250/$30, 500/$50**) as Polar one-time purchases → on `order.paid`, credit a `topup_purchase` UsageRecord with a 3-month expiry.
- **Checkout:** Polar hosted checkout / 6-line component from `billing/checkout/route.ts`. No custom card UI.
- **Customer portal:** Polar out-of-box portal linked from the billing page.
- **Webhooks:** `billing/webhook/route.ts` validates with `POLAR_WEBHOOK_SECRET` (Standard Webhooks). Handle: `order.paid` (subscription grant + one-time pack credit, **idempotent**), `subscription.created/updated/canceled/past_due`, `customer.state_changed`. Respond fast, process async.
- **Env:** `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` (+ product/price IDs in config, not secrets).

### Razorpay (India)
- Razorpay for Indian customers, INR pricing (monthly + annual USD × 100): ₹2,900 / ₹9,900 / ₹29,900 monthly; ₹29,500 / ₹95,000 / ₹2,69,000 annual.
- **Geo-IP routing:** detect India (edge/header) → INR + Razorpay; else USD + Polar. Manual currency override.
- **Recurring:** UPI AutoPay mandates; note the ₹15,000 AutoPay cap — Team (₹29,900/mo) and all annual prepayments exceed it → use card/netbanking mandate or one-time annual invoice; handle gracefully.
- **One-time minute packs:** Razorpay one-time payment (UPI/card/netbanking) → credit `topup_purchase` with 3-month expiry.
- **GST invoicing:** capture **GSTIN** at checkout for B2B; GST-compliant invoices (CGST/SGST or IGST split). 18% GST on SaaS.
- **Env:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.
- **Webhooks:** Razorpay subscription/payment events → same internal sync path as Polar.

### Unify behind one internal contract
Both providers feed a single internal `syncSubscription(workspaceId, provider, externalId, plan, status, interval)` and `creditTopUp(workspaceId, provider, minutes, expiresAt)` → update `BillingAccount` + `Workspace.plan`/`billingStatus`, grant the period pool, or credit the pack. Provider-specific code stays in adapters.

## Entitlement Gating & Enforcement

## Entitlement Gating & Enforcement

Central `packages/billing/entitlements.ts` exposing `assertScanAllowed(workspaceId, mode)`, `assertTargetAllowed(workspaceId)`, `assertFixPrAllowed(workspaceId)`, `getUsageBalance(workspaceId)`, `getTrialState(workspaceId)`, and `getGraceState(workspaceId)`.

**Enforce at these points:**
- **Scan creation:** check the scan-depth gate — **Deep/Custom require PRO or above (NOT Trial, NOT Starter)**; check agent-minute balance > 0 (or remaining ≥ estimated cost); check scan-frequency throttle for trial. Fail closed with a clear upgrade CTA (a blocked Deep attempt → "Deep is a Pro feature").
- **Target creation/activation:** enforce protected-target cap per plan (trial: 1–2).
- **Fix-PR generation:** full-featured in trial and paid (no per-fix cap in the unified model).
- **Feature gates:** weekly monitoring, Slack/Discord, MCP, GitHub Action, scheduled scans, Jira/Linear, branded reports, client share links, multi-workspace, priority support — per plan map. (Trial = full-featured on Standard/Quick.)

**Trial gating (no card on file):**
- `getTrialState` returns days-left + minutes-left + target usage. Block new agent-min-consuming scans when minutes/targets exhausted OR 14 days elapsed → read-only/locked state + upgrade CTA. Never auto-convert, never charge (no card).

**Soft warnings + exhaustion grace (founder, 2026-08-16):**
- 80%-of-pool usage email/notification before exhaustion.
- **New scans** at pool exhaustion: hard wall (balance <= 0 → no new agent-min-consuming scans) with an upgrade/top-up CTA. Never bill overage without opt-in (Team spend limit respected as a circuit breaker).
- **In-flight scan** at pool exhaustion: do NOT hard-stop — grant up to **15 minutes of free grace** to let it finish (see the Exhaustion grace period subsection of the Usage Metering Spec). Finish inside grace → unused grace evaporates, workspace blocked until minutes purchased. Exceed grace → stop the scan and surface "minutes + grace period over."

**Behavior on downgrade/cancel:** on `subscription.canceled`/past_due, move workspace to a read-only/limited state at period end, keep data, stop paid-only scans/features, audit-log the transition. (No permanent free tier — lapsed paid = locked/read-only, upgrade to resume.)

## Email Verification Flip (Brevo)

## Email Verification Flip (Brevo) — Phase 0 prerequisite

Currently `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION="0"` (open registration accepts unverified addresses — a known production blocker and a free-tier COGS-abuse vector). Flip to enforced before the free tier opens to public/paid-adjacent traffic.

**Steps:**
1. Provision a **Brevo API key** + a **verified sender address** (founder/ops action — coordinate).
2. Set `BREVO_API_KEY` and `EMAIL_FROM` (verified sender) as production secrets.
3. Set the `LYRASHIELD_REQUIRE_EMAIL_VERIFICATION` repo variable to `"1"` (deploy workflow reads it, defaults to `"0"`).
4. Deploy. `packages/auth` enforces verification once flag + provider are both present; the env schema's boot-time refinement (`packages/config/src/env.ts`) guarantees flag and provider can never disagree (fails fast rather than silently accepting unverified sign-ups).

**Do NOT** set the flag to `"1"` without a working Brevo key — the deploy will fail fast by design. Gate verification enforcement on scan/billing use; keep the email + 80%-usage notifications on the same provider.

## Analytics & Events

## Analytics & Events (privacy-safe, allowlisted)

Emit product-analytics events (PostHog, already wired via `NEXT_PUBLIC_POSTHOG_KEY`) for the monetization funnel — allowlisted, no PII/target/finding data:
- `pricing_viewed {mode: local|cloud}`, `checkout_started {plan, region}`, `checkout_completed {plan, region, provider}`, `checkout_abandoned {plan}`.
- Trial funnel: `trial_started`, `trial_scan_completed`, `trial_limit_hit {kind}`, `trial_expired`, `trial_upgraded {plan}`.
- `pool_warning_80 {plan}`, `pool_exhausted {plan}`, `topup_purchased {plan, pack}`, `overage_enabled {plan}`.
- `upgrade_clicked {fromPlan, toPlan}`, `downgrade {fromPlan, toPlan}`.
- Free-surface attribution: `tool_used {tool}`, `lite_check_completed`, `action_gate_ran`, `freesurface_to_signup {source}`.

Do NOT emit: cost, spend, budget-cap, target identity, finding content, raw IP, or referral/session identifiers to third-party analytics. Keep event names stable for the Analytics & Reporting Agent.

## Acceptance Criteria

## Acceptance Criteria (verify before claiming done)

**Plans & schema**
- [ ] `packages/billing` exists with plan definitions as data (3 self-serve tiers monthly+annual, minute packs, contact-led top tier, **14-day trial state**); `STARTER` added to `WorkspacePlan` via additive `ALTER TYPE ... ADD VALUE` migration (non-transactional, deployed before code that references it).
- [ ] `UsageRecord.idempotencyKey` (already present, unique) is **set on every metered/grant event** — test proves retried webhook/job replays do not double-grant or double-debit.
- [ ] All new env vars added to `packages/config/src/env.ts` (fail-fast), `.env.example`, and `turbo.json` `globalEnv`; billing secrets wired into `deploy-azure.yml` as `secretref:*`.

**Dual gateway (self-serve tiers only)**
- [ ] Polar: products for Starter/Pro/Team each with monthly + annual prices; one-time minute-pack products (100/$15, 250/$30, 500/$50); hosted checkout; customer portal; webhooks (`order.paid` idempotent pool grant + pack credit, subscription lifecycle) validated with `POLAR_WEBHOOK_SECRET`; webhook idempotency via `WebhookEvent @@unique([provider, externalId])`.
- [ ] Razorpay: INR subscriptions monthly (₹2,900/₹9,900/₹29,900) + annual (₹29,500/₹95,000/₹2,69,000); UPI AutoPay with >₹15k fallback; one-time minute-pack payments; GSTIN capture + GST-compliant invoices; webhooks → same internal sync path as Polar.
- [ ] Geo-IP routing selects Polar (USD) vs Razorpay (INR) with a manual override.
- [ ] Agency/Enterprise $499 tier has **no checkout** — contact form only.
- [ ] **Refund handling:** Cloud 14-day money-back — refund webhook reverses entitlement + idempotent `refund_reversal` + triggers affiliate-commission clawback.

**Trial**
- [ ] 14-day no-card trial: **100 agent-min hard cap, Standard/Quick only (NO Deep)**, 1–2 target cap, email verification required, no auto-convert; expiry/limit → read-only/locked state + upgrade CTA.

**Metering & gating**
- [ ] Agent-minute metering records active-loop time, Deep at 3×, per-cycle balance correct; idempotent monthly pool grant (incl. annual subs granting monthly); included pool no rollover; **minute packs valid 6 months** with idempotent expiry debit; draw order = pool then oldest unexpired pack.
- [ ] `assertScanAllowed`/`assertTargetAllowed`/`assertFixPrAllowed`/`getTrialState` enforced; **Deep/Custom blocked on Trial + Starter (Pro+ only)**; 80% warning + hard wall + upgrade CTA work.
- [ ] Downgrade/cancel → read-only/limited state at period end, data retained, audit-logged.

**UI**
- [ ] Billing page shows plan/trial status/interval/usage (no $ cost values), unexpired pack minutes + expiry, portal link, upgrade/downgrade + monthly↔annual, minute-pack purchase, spend limit (Team).
- [ ] Pricing page: **one page, Local/Cloud toggle**; Cloud view = 3 self-serve tiers with monthly/annual + USD/INR toggles, minute-pack add-on, "Agency/Enterprise from $499" contact-led line; trial CTA (no card); Deep clearly marked Pro+; confirmed copy; agent-minute definition + pack validity (6 months) + overage rate ($0.15/min) + **14-day money-back (Cloud)** published clearly.

**Email verification**
- [ ] Brevo provisioned, secrets set, flag flipped to `"1"`, deploy green, verification enforced before trial opens publicly.

**Quality gates**
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all green; Playwright E2E for trial signup → trial limit, Deep-blocked-on-trial/Starter, checkout (monthly + annual), minute-pack purchase, refund-reversal, and gating happy paths.
- [ ] No public benchmark/coverage/"only-we"/upstream-engine claims; money-back language only for Cloud, never Local.

**Out of scope (defer):** enterprise SSO/SCIM/private workers build, proration edge cases, marketplace listings, self-serve checkout for the $499 tier, Local-mode license billing (separate Track B brief).

**Process:** branch + PR (never push to main), verify green, merge only on explicit founder approval. Flag any plan-mapping or copy conflict back to the founder/marketing rather than guessing.
