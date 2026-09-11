/**
 * Account-owned subscription resolution (launch-review remediation WP-A).
 *
 * Subscriptions belong to accounts (User.id), not workspaces. A single
 * account can hold several BillingAccount rows over time (multiple provider
 * contracts, a trial marker row, legacy rows attributed to different
 * workspaces). These helpers pick the row that governs entitlement
 * deterministically — they never merge contracts and never guess ownership.
 */

import { prisma } from "@lyrashield/db"
import type { BillingAccount } from "@lyrashield/db"

type DbClient = Pick<typeof prisma, "billingAccount">

export interface ResolvedAccountBilling {
  id: string
  accountId: string | null
  /** Purchase-attribution workspace (NULL for account-only rows). */
  workspaceId: string | null
  purchaseWorkspaceId: string | null
  provider: string
  externalId: string | null
  status: string
  currentPlan: string
  /**
   * The plan that currently ENTITLES. `currentPlan` is the contract record;
   * a canceled/past_due row keeps it until the downgrade job runs, but the
   * account stops being entitled the instant `currentPeriodEnd` lapses — so
   * the effective plan is FREE. Active/in-term rows return `currentPlan`.
   */
  effectivePlan: string
  interval: string | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  canceledAt: Date | null
  trialEndsAt: Date | null
  spendLimitCents: number | null
  graceUsedMs: number
  graceCycleStart: Date | null
}

/**
 * Status precedence when several billing rows belong to one account. Lower
 * wins: an active paid subscription always governs over a stale trial row.
 * Rows past their paid term (status canceled/past_due with a lapsed
 * currentPeriodEnd) never outrank a live trial.
 */
function statusRank(account: {
  status: string
  provider: string
  currentPeriodEnd: Date | null
}): number {
  switch (account.status) {
    case "active":
      return 0
    case "past_due":
      return 1
    case "canceled":
      // A canceled subscription still governs until its paid term ends.
      return account.currentPeriodEnd && account.currentPeriodEnd.getTime() > Date.now() ? 2 : 6
    case "trialing":
      return 3
    case "trial_expired":
      return 4
    default:
      return 5
  }
}

/**
 * Resolve the account's governing BillingAccount row, or null when the
 * account has none. Deterministic: status rank, then latest period start,
 * then latest update — replay and backfill order cannot change the answer.
 */
export async function resolveAccountBilling(
  accountId: string,
  db: DbClient = prisma
): Promise<ResolvedAccountBilling | null> {
  const rows = await db.billingAccount.findMany({
    where: { accountId, deletedAt: null },
    orderBy: [{ updatedAt: "desc" }],
  })
  if (rows.length === 0) return null

  const ranked = rows
    .map((row) => ({ row, rank: statusRank(row) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      const aStart = a.row.currentPeriodStart?.getTime() ?? 0
      const bStart = b.row.currentPeriodStart?.getTime() ?? 0
      if (aStart !== bStart) return bStart - aStart
      return b.row.updatedAt.getTime() - a.row.updatedAt.getTime()
    })

  const row = ranked[0]!.row
  const termLapsed =
    (row.status === "canceled" || row.status === "past_due") &&
    row.currentPeriodEnd !== null &&
    row.currentPeriodEnd.getTime() <= Date.now()
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    purchaseWorkspaceId: row.purchaseWorkspaceId,
    provider: row.provider,
    externalId: row.externalId,
    status: row.status,
    currentPlan: row.currentPlan,
    effectivePlan: termLapsed ? "FREE" : row.currentPlan,
    interval: row.interval,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    canceledAt: row.canceledAt,
    trialEndsAt: row.trialEndsAt,
    spendLimitCents: row.spendLimitCents,
    graceUsedMs: row.graceUsedMs,
    graceCycleStart: row.graceCycleStart,
  }
}

/**
 * All non-deleted billing rows owned by the account (every contract).
 * Entitlement uses `resolveAccountBilling`; this exists for audit/receipt
 * surfaces and the reconciliation job.
 */
export async function listAccountBilling(
  accountId: string,
  db: DbClient = prisma
): Promise<BillingAccount[]> {
  return db.billingAccount.findMany({
    where: { accountId, deletedAt: null },
    orderBy: [{ updatedAt: "desc" }],
  })
}
