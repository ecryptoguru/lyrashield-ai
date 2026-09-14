/**
 * Paid-account funnel truth — derived from BillingAccount rows, never from
 * analytics events. `active_paid_accounts` is the headline KPI the growth
 * program is measured against.
 *
 * An account is an active paid account when its billing row is provider-
 * backed (polar/razorpay — never `trial` or `complimentary`), status is
 * `active`, the plan is not FREE, and the account is not a platform
 * administrator. Multiple rows per account (trial marker + subscription)
 * dedupe to one account.
 *
 * MRR is computed from the shared USD catalog as a monthly equivalent
 * (annual / 12). INR-purchased subscriptions count at the published USD
 * price — a reporting convention, not a settlement figure.
 */

import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"

export interface BillingMetricRow {
  accountId: string | null
  provider: string
  status: string
  currentPlan: string
  interval: string | null
  currentPeriodEnd: Date | null
  canceledAt: Date | null
  createdAt: Date
}

export interface PaidAccountMetrics {
  /** status=active, provider-backed, non-FREE, non-admin, deduped by account. */
  activePaidAccounts: number
  /** Still paying through current term: active + past_due + canceled-in-term. */
  paidAccountsInTerm: number
  /** Active paid accounts whose paid row was created in the last 30 days. */
  newPaidAccounts30d: number
  /** Provider-backed paid rows canceled in the last 30 days (account-deduped). */
  canceled30d: number
  /** Monthly-equivalent recurring revenue in USD (catalog price). */
  mrrUsd: number
  arrUsd: number
  /** activePaidAccounts split by currentPlan. */
  planMix: Record<string, number>
}

const PAID_PROVIDERS = new Set(["polar", "razorpay"])
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function monthlyEquivalentUsd(plan: string, interval: string | null): number {
  const catalog = CLOUD_PLAN_MAP[plan as keyof typeof CLOUD_PLAN_MAP]
  if (!catalog) return 0
  return interval === "annual" ? catalog.price.usd.annual / 12 : catalog.price.usd.monthly
}

export function computePaidAccountMetrics(
  rows: BillingMetricRow[],
  { excludedAccountIds, now = new Date() }: { excludedAccountIds: Set<string>; now?: Date }
): PaidAccountMetrics {
  const providerRows = rows.filter(
    (row) =>
      row.accountId !== null &&
      PAID_PROVIDERS.has(row.provider) &&
      !excludedAccountIds.has(row.accountId)
  )
  const paidRows = providerRows.filter((row) => row.currentPlan !== "FREE")
  const recentlyCanceled = new Set(
    providerRows
      .filter(
        (row) =>
          row.canceledAt !== null && now.getTime() - row.canceledAt.getTime() <= THIRTY_DAYS_MS
      )
      .map((row) => row.accountId)
  )

  // One account can hold several paid-provider rows over time (e.g. a
  // canceled contract plus a new subscription). Dedupe to the newest row per
  // account — deterministic ordering by recency of creation.
  const newestByAccount = new Map<string, BillingMetricRow>()
  for (const row of paidRows) {
    const existing = newestByAccount.get(row.accountId!)
    if (!existing || row.createdAt.getTime() > existing.createdAt.getTime()) {
      newestByAccount.set(row.accountId!, row)
    }
  }

  const inTerm = (row: BillingMetricRow) =>
    row.status === "active" ||
    row.status === "past_due" ||
    (row.status === "canceled" &&
      row.currentPeriodEnd !== null &&
      row.currentPeriodEnd.getTime() > now.getTime())

  const activeRows = [...newestByAccount.values()].filter((row) => row.status === "active")
  const planMix: Record<string, number> = {}
  let mrrUsd = 0
  for (const row of activeRows) {
    planMix[row.currentPlan] = (planMix[row.currentPlan] ?? 0) + 1
    mrrUsd += monthlyEquivalentUsd(row.currentPlan, row.interval)
  }

  return {
    activePaidAccounts: activeRows.length,
    paidAccountsInTerm: [...newestByAccount.values()].filter(inTerm).length,
    newPaidAccounts30d: activeRows.filter(
      (row) => now.getTime() - row.createdAt.getTime() <= THIRTY_DAYS_MS
    ).length,
    canceled30d: recentlyCanceled.size,
    mrrUsd,
    arrUsd: mrrUsd * 12,
    planMix,
  }
}
