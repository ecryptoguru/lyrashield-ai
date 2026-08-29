# WP1 — Repricing & Billing (atomic, first)

Implements the founder-confirmed (2026-08-29) two-line repricing and the new
scan-billing rules. **Atomic by design** — a half-migrated pricing state is the
worst failure mode, so plans, enum, entitlements, metering, billing UI, and
provider-key parsing all land in this one PR.

Source of truth: *LyraShield — Repricing + Launch Assurance Program:
Engineering Handoff* (founder-approved). Companion: *Premium Repackaging &
Narrow Positioning Decision Doc (Aug 2026)*.

## Canonical plan table (now in code)

| Plan | Monthly USD | Monthly INR | Annual USD | Annual INR | Agent-min | Targets | Self-serve | Deep |
|---|---|---|---|---|---|---|---|---|
| Trial | $0 | ₹0 | — | — | 100 one-time | 3 | auto on signup | No |
| Starter | $29 | ₹2,900 | $295 (15% off) | ₹29,500 | 300/mo | 5 | Yes | No |
| Pro | $99 | ₹9,900 | $950 (20% off) | ₹95,000 | 1,200/mo | 15 | Yes | Yes |
| **Launch Assurance** | **$499** | **₹49,900** | **$4,188 (30% off)** | **₹418,800** | **6,000/mo** | **50** | **Yes** | Yes |
| Enterprise | from $1,500 | from ₹150,000 | — | — | Custom | Custom | No, contact-led | Yes |

- Team $299 **removed**, merged into Launch Assurance.
- $4,188 is deliberate (clean $349/mo). Annual ladder is now 15 / 20 / 30.
- Overage stays $0.15/agent-min, Deep/Custom keep the 3× multiplier, minute
  packs unchanged (100/$15, 250/$30, 500/$50, 180-day, drawn after monthly pool).
- **Integrations (GitHub, Slack, Jira) move DOWN to Pro.** RBAC and shared
  reports stay at Launch Assurance and above.

## What changed

- **`packages/pricing/src/plans.ts`** — catalog rewritten to the canonical
  table. Team and Agency entries removed; `LAUNCH_ASSURANCE` added
  (`selfServe: true`, populated annual — does NOT inherit the old Agency
  `annual: 0 / selfServe: false` shape); `ENTERPRISE` keeps `selfServe: false`
  with a stated `from` price of $1,500 and roadmap-qualified feature strings.
- **Prisma enum** — `LAUNCH_ASSURANCE` added via additive, non-transactional
  `ALTER TYPE ... ADD VALUE IF NOT EXISTS` (migration `20260829000000`),
  matching the existing Sprint-10 STARTER migration pattern. **TEAM is retained,
  not dropped** (enum removal is a separate, riskier migration and is out of
  scope). `packages/types` `WorkspacePlanSchema` mirror updated.
- **Entitlements** — protected-target caps are now **hard-enforced for every
  plan** (were trial-only/advisory). Over-cap behaviour: **block adding new
  targets, existing targets stay fully readable and scannable, nothing is
  silently deleted.** A workspace downgraded below its count is over cap and
  cannot add more until it removes targets or upgrades.
- **Scan billing (founder-confirmed 2026-08-29):**
  - **Failed scans are never billed** — no `agent_minutes` UsageRecord for a
    failed terminal state, regardless of work completed. Fixes the Aug-25 case
    where four 15-second failed scans each billed a full minute.
  - **Cancelled scans bill elapsed time only** — the 1-minute floor is not
    applied. **Rounding rule (documented):** whole-minute ceiling, so a cancel
    at 20 s bills 1 minute; the floor is simply not the mechanism, and
    `ms <= 0` bills 0. True per-second billing is impractical because
    `UsageRecord.quantity` and all pool/pack arithmetic are integer minutes.
  - Both rules are surfaced in the billing UI.
- **Overage spend-limit opt-in** moves from Team to Launch Assurance
  (`currentPlan === "LAUNCH_ASSURANCE"`) across the entitlement gate, overage
  debit, worker, and the spend-limit route.
- **Provider catalog key parser** accepts `launch_assurance_{monthly,annual}`
  for both Polar and Razorpay.
- **Marketing pricing page** — Enterprise contact-led block uses the qualified
  wording (SSO/SAML, multi-workspace and dedicated SLA are roadmap /
  on-request, qualifier preserved per copy constraints).

## Decisions made (mine, per handoff)

1. **Enum value for Launch Assurance: `LAUNCH_ASSURANCE`** (new explicit value,
   not a reuse of `BUSINESS`) — a customer-facing "Launch Assurance" backed by
   an internal `BUSINESS`/`TEAM` would confuse every future reader, and the
   zero-paying-customer state makes a clean value safe. Enterprise continues
   mapping to `AGENCY` internally per existing convention.
2. **Over-cap / downgrade:** block new target creation, keep existing targets
   readable, never delete. (Marketing's recommendation; treated as an
   implementation behaviour, not a product decision requiring founder sign-off —
   flagging here for the record.)

## Verification

- **By execution:** the real `plans.ts` catalog and the real
  `recordAgentMinutes()` were run (Node type-stripping + a stubbed
  `@lyrashield/db`): **37 checks pass** covering the canonical table, the
  failed/cancelled rounding rules (incl. the Aug-25 15 s case and Deep 3×),
  and a copy-constraint scan of the feature arrays (no "will be secure", no
  benchmark/detection-rate numbers, no "only we", no money-back, no LTD, no
  present-tense auto-fix).
- **Unit tests updated/added:** pricing catalog contract, target-cap
  enforcement (over-cap, downgrade, trial), `shouldRecordAgentMinutes`
  failed/cancelled semantics, and `recordAgentMinutes` outcome rules.
- **CI-verified only:** the sandbox cannot `pnpm install` (npm registry is
  blocked), so `pnpm typecheck / lint / test / build` run in CI. No new runtime
  dependencies were added, so `pnpm-lock.yaml` is unchanged.

## Explicitly NOT in this PR (paused for founder)

Live payment-provider and production operations were **not** performed — this
PR came via a non-owner invoker and these touch production payment surfaces, so
they wait for Ankit's explicit go:

- Creating/archiving Launch Assurance products in **Polar Live** and
  **Razorpay Live** (code maps env product IDs generically; the catalog change
  is config, not code).
- Deploying the enum migration to production.
- Non-production test checkout on Launch Assurance monthly + annual, and
  verifying the **Razorpay non-AutoPay (card/netbanking) fallback** for
  ₹49,900 monthly / annual prepayments (UPI AutoPay caps at ₹15,000).

## Copy constraints

Every user-facing string follows the binding constraints — no "will be secure",
no benchmark/detection/false-positive numbers, no "only we", no upstream engine
name, no "money-back guarantee", no lifetime/permanent-free tier, fixes are
approval-gated proposals (nothing auto-merges), Deep not described as live, and
Enterprise controls qualified as roadmap/on-request.
