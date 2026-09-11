# 2026-09-11 — Account-owned subscriptions + monthly allowance cycle (WP-A / WP-B / F1)

Launch-review remediation. Founder-approved payer policy: **the account
starting a scan uses its own subscription; scheduled and delegated work uses
its explicitly recorded sponsoring account. Joining a workspace does not
share another account's subscription.**

## Ownership model

- `BillingAccount.accountId` = owning user (the subscription contract owner).
  `workspaceId` remains as **purchase attribution** only (which workspace
  context the purchase was made from); it stays `@unique` — at most one
  billing row may be attributed to a workspace at a time, so rows whose
  attribution slot is taken are created account-only (`workspaceId NULL`,
  `purchaseWorkspaceId` keeps provenance). Subscription identity is
  `@@unique([provider, externalId])`.
- `UsageRecord.accountId` = the account balance the record draws on.
  `workspaceId` remains attribution (where the consumption happened).
- `MinutePack.accountId` = pack owner.
- Sponsor identity is **not a new column**: `Scan.createdById`,
  `Schedule.createdById`, `ApiKey.createdById`, and `AgentConnection.userId`
  are already the persisted, authorized sponsoring account:
  - browser scan → `session.userId`
  - API-key scan → `session.userId` = `ApiKey.createdById` (keys act for creator)
  - OAuth-delegated scan → `session.userId` = `AgentConnection.userId`
  - scheduled scan → `Schedule.createdById` (recorded at creation)
  - fix-PR auto retest → **source scan's `createdById`** (changed from
    "current workspace owner" — a guess, now a recorded account)
- Missing/unresolvable sponsor fails closed: no fallback to workspace owner.

## Allowance cycle (F1)

- `allowance-cycle.ts`: `resolveAllowanceCycle({interval, periodStart,
periodEnd, at})` → `{cycleStart, cycleEnd}`. Monthly anniversaries of the
  term anchor (`currentPeriodStart`), UTC, month-end clamped, each cycle
  computed from the anchor (no chained drift: Jan 31 → Feb 28 → Mar 31).
- Monthly subs: cycle == provider period (anchor moves each renewal).
  Annual subs: monthly anniversary cycles inside the annual term.
- Grant idempotency key: `{accountId}:{cycleStartIso}:{plan}` plus a legacy
  probe on `{workspaceId}:{periodStart}:{plan}` so rows written by the old
  binary mid-rollout cannot double-grant.
- Balance/meter/overage scope consumption and grants to
  `accountId + cycleStart >= currentCycleStart`.
- `billing-allowance-replenishment` job (hourly, same scheduler as the
  downgrade job): for every `active`/`trialing` account row, plus
  `canceled`/`past_due` rows before `currentPeriodEnd`, compute the current
  cycle and grant idempotently. Covers annual monthly pools (no provider
  event exists for them) and missed monthly renewals after downtime.
- No rollover, proration, or catch-up stacking: exactly one pool per
  (account, cycle, plan); expired cycles simply stop counting.

## RLS / scoping boundary

- New `app.current_account_id()` GUC + `withAccountRLS(accountId, fn)` and an
  optional `accountId` on `withWorkspaceRLS` (dual context for the metering
  transaction: writes attributed rows + reads the account-wide ledger).
- Account permissive policies on `BillingAccount`, `UsageRecord`,
  `MinutePack` (`"accountId" = app.current_account_id()`, OR-ed with the
  existing workspace policies), with an additional restrictive owner boundary that
  denies workspace-only access to every mapped account row. All other tables keep
  workspace-only scope.
- `applyQueryGuards`: for the three account-owned models, an explicit
  `accountId` in `where` suppresses the auto-`workspaceId` injection (the DB
  policy is the real boundary; the injection is only a backstop).

## Caller inventory (entry → principal → resource ws → billing owner)

| Entry point                       | Principal                    | Billing owner (sponsor)                                  | Persistence                              |
| --------------------------------- | ---------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| POST /api/scans                   | browser/apikey/oauth session | `session.userId`                                         | `Scan.createdById`                       |
| GET /api/scans/eligibility        | same (read-only)             | `session.userId`                                         | —                                        |
| POST /api/findings/[id]/retests   | session                      | `session.userId`                                         | `Scan.createdById`                       |
| Schedule runner                   | `Schedule.createdById`       | same                                                     | `Scan.createdById`                       |
| GitHub fix-PR merge retest        | system                       | source `Scan.createdById`                                | `Scan.createdById`                       |
| billing webhooks (polar/razorpay) | provider signature           | `metadata.accountId` → row `accountId` → legacy resolver | `BillingAccount`                         |
| checkout / topup                  | `billing.manage` member      | `session.userId` stamped in provider metadata            | provider metadata                        |
| usage/portal/spend-limit          | account itself               | `session.userId`                                         | `BillingAccount.accountId`               |
| trial start                       | `billing.manage` member      | `session.userId`                                         | `User.trialStartedAt`, grant `accountId` |
| run-scan metering                 | worker                       | `Scan.createdById` (read in-tx)                          | `UsageRecord.accountId`                  |
| downgrade/expiry/replenish        | jobs                         | row's `accountId`                                        | `BillingAccount`                         |
| account deletion                  | system                       | —                                                        | rows retained, sponsor fails closed      |

`workspace.plan`/`deepAllowed` remain as workspace-attribution display
fields (synced for the purchase workspace); entitlement, caps, the
domain-proof gate, the free-URL limiter, and Cloud-sync eligibility now
evaluate the **sponsor account's** plan.

`ResolvedAccountBilling.effectivePlan` is the entitlement-facing plan: a
`canceled`/`past_due` row keeps its contract `currentPlan` until the hourly
downgrade job flips it, but entitles as FREE the instant `currentPeriodEnd`
lapses. Display surfaces keep `currentPlan` + `status` (the contract record);
money/entitlement checks use `effectivePlan`.

## Migration and production cutover constraints

This branch has not been deployed or backfilled in production. Expansion is additive,
but **an old image is not safe to run after ownership cutover**: it does not bind
account context or use the new allowance identity. The legacy-key probe is one-way
compatibility after an owner is mapped; it is not protection against an old writer
creating a different workspace-keyed grant after a new writer. Do not describe this
as a verified rolling migration or automatic image rollback.

1. On isolated infrastructure, expand schema and verify current code/RLS. Account
   rows are protected by restrictive owner policies even when workspace attribution
   matches another member. Unmapped NULL-owner rows retain legacy workspace access.
2. Inventory every legacy billing contract, pool grant/debit, pack, and provider
   reference. Run `backfill-account-billing.ts` in dry-run mode. It uses already-mapped
   billing contracts or an explicitly reviewed `--mapping=/absolute/file.json`
   mapping of BillingAccount IDs to verified User IDs. It never picks an owner from
   workspace membership. Records without a mapping remain exceptions.
3. Preserve old workspace-pool grants **and their historical consumption** on the
   same mapped owner. Do not retroactively move old debits to scan creators while
   moving their grants elsewhere. New admissions use the approved initiating-account
   payer policy. Backfill updates only ownership columns, never monetary/minute amounts.
4. Before production apply, resolve all affected exceptions and independently reconcile
   counts, grant totals, usage, pack balances, provider IDs and trial history. The script
   is not a complete financial reconciliation tool. Retain the approved mapping and
   review evidence alongside receipts. No production mappings have been fabricated.
5. Use an explicitly reviewed coordinated cutover with admission paused and paid work
   drained; do not replay ambiguous jobs. Upgrade every writer, backfill, verify account
   reads and balances, then resume. This operational sequence requires separate release
   authorization and rehearsal. New billing rows use NULL workspace attribution and
   retain purchase provenance; existing attributed rows remain account-protected.
6. Rollback after cutover requires a compatible account-aware image or keeping billing
   admission stopped while fixing forward. Do not roll back to the workspace-only image
   and assume grants/charges remain safe. Never reverse production schema migrations.

The two complimentary grants use account-only rows and work without membership. Audit
records are attributed to an explicitly supplied administrative workspace; that workspace
does not receive plan access or minutes. The operation requires `--audit-workspace` and
`--actor-user` identifying a verified platform operator, records intent/completion, and
revokes only grants carrying the exact complimentary BillingAccount ID. No operation was
run in production. Review credit reconciliation and operation receipts before applying it.

## Non-goals

No price/engine/product-name changes; license activation and perpetual
bindings unchanged; `WebhookEvent`/affiliate flows unchanged; grace budget
moves from `Workspace` to `BillingAccount` (per-account, per-cycle) — legacy
workspace grace columns remain but are no longer written by the new binary.
