/**
 * Usage balance computation.
 *
 * The available agent-minute balance for a workspace is:
 *
 *   pool (monthly grant) + Σ unexpired pack minutes − consumed minutes
 *
 * Draw order when consuming minutes: monthly pool first, then oldest pack,
 * then overage (Team opt-in only). Overage is consumed AFTER pool + packs,
 * so it does NOT reduce the pool or pack remaining.
 *
 * Pack consumption is computed from UsageRecords rather than trusting the
 * MinutePack.remainingMinutes column directly: after pool minutes are
 * exhausted, consumption spills into packs. So:
 *   packConsumed = max(0, poolConsumed - poolMinutes)
 *   packRemaining = Σ unexpired packs' original minutes - packConsumed
 *
 * This module is read-only — it computes the current balance snapshot.
 */

import { prisma } from "@lyrashield/db"

export interface UsageBalance {
  /** Minutes granted this cycle (monthly pool or trial one-time grant). */
  poolMinutes: number
  /** Minutes consumed from the pool this cycle. */
  poolConsumed: number
  /** Remaining pool minutes (poolMinutes − poolConsumed, floored at 0). */
  poolRemaining: number
  /** Total remaining minutes across all unexpired packs. */
  packRemaining: number
  /** Total original minutes across all unexpired packs (before consumption). */
  totalPackMinutes: number
  /** Minutes consumed from packs this cycle (spillover beyond pool). */
  packConsumed: number
  /** Details of each unexpired pack. */
  packs: PackBalance[]
  /** Total remaining across pool + packs. */
  totalRemaining: number
  /** Overage minutes consumed beyond pool + packs (Team opt-in only). */
  overageConsumed: number
  /** Cycle start timestamp for the current billing period. */
  cycleStart: Date | null
}

export interface PackBalance {
  id: string
  remainingMinutes: number
  expiresAt: Date | null
  purchasedAt: Date
}

/** UsageRecord kinds that represent minute grants (pool or trial). */
const GRANT_KINDS = new Set(["pool_grant", "trial_grant"])

/** UsageRecord kinds that represent minute consumption. */
const CONSUME_KINDS = new Set(["agent_minutes", "overage_minutes"])

/**
 * Compute the current usage balance for a workspace.
 *
 * Pool grants and consumption are scoped to the current billing cycle
 * (cycleStart on the BillingAccount). Pack balances are independent of
 * the cycle — they persist until expiry.
 */
export async function getUsageBalance(workspaceId: string): Promise<UsageBalance> {
  // First fetch the billing account to get the cycle start
  const billingAccount = await prisma.billingAccount.findUnique({
    where: { workspaceId },
    select: { currentPeriodStart: true, currentPlan: true },
  })

  const cycleStartFilter = billingAccount?.currentPeriodStart
    ? { cycleStart: { gte: billingAccount.currentPeriodStart } }
    : {}

  const [packs, grantRecords, consumeRecords] = await Promise.all([
    prisma.minutePack.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { purchasedAt: "asc" },
      select: {
        id: true,
        minutes: true,
        remainingMinutes: true,
        expiresAt: true,
        purchasedAt: true,
      },
    }),
    // Pool/trial grants for the current cycle
    prisma.usageRecord.findMany({
      where: {
        workspaceId,
        kind: { in: [...GRANT_KINDS] },
        deletedAt: null,
        ...cycleStartFilter,
      },
      select: { quantity: true },
    }),
    // Consumption for the current cycle
    prisma.usageRecord.findMany({
      where: {
        workspaceId,
        kind: { in: [...CONSUME_KINDS] },
        deletedAt: null,
        ...cycleStartFilter,
      },
      select: { kind: true, quantity: true },
    }),
  ])

  const poolMinutes = grantRecords.reduce((sum, r) => sum + r.quantity, 0)
  const poolConsumed = consumeRecords
    .filter((r) => r.kind === "agent_minutes")
    .reduce((sum, r) => sum + r.quantity, 0)
  const overageConsumed = consumeRecords
    .filter((r) => r.kind === "overage_minutes")
    .reduce((sum, r) => sum + r.quantity, 0)

  // Overage is consumed AFTER pool + packs, so it does NOT reduce pool remaining.
  const poolRemaining = Math.max(0, poolMinutes - poolConsumed)

  // Pack consumption: consumption spills into packs only after the pool is
  // exhausted. Compute packConsumed from UsageRecords rather than trusting
  // MinutePack.remainingMinutes directly (which may be stale if the expire
  // job hasn't run or if packs were credited but consumption wasn't attributed).
  const packConsumed = Math.max(0, poolConsumed - poolMinutes)

  // Sum original minutes across all unexpired packs, then subtract pack consumption.
  const totalPackMinutes = packs.reduce((sum, p) => sum + p.minutes, 0)
  const packRemaining = Math.max(0, totalPackMinutes - packConsumed)

  return {
    poolMinutes,
    poolConsumed,
    poolRemaining,
    packRemaining,
    totalPackMinutes,
    packConsumed,
    packs: packs.map((p) => ({
      id: p.id,
      remainingMinutes: Math.max(0, p.remainingMinutes),
      expiresAt: p.expiresAt,
      purchasedAt: p.purchasedAt,
    })),
    totalRemaining: poolRemaining + packRemaining,
    overageConsumed,
    cycleStart: billingAccount?.currentPeriodStart ?? null,
  }
}
