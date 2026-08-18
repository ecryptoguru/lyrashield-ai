/**
 * Usage balance computation.
 *
 * The available agent-minute balance for a workspace is:
 *
 *   pool (monthly grant) + Σ unexpired pack minutes − consumed minutes − overage consumed
 *
 * Draw order when consuming minutes: monthly pool first, then oldest pack.
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
        remainingMinutes: { gt: 0 },
      },
      orderBy: { purchasedAt: "asc" },
      select: {
        id: true,
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

  const poolRemaining = Math.max(0, poolMinutes - poolConsumed - overageConsumed)
  const packRemaining = packs.reduce((sum, p) => sum + p.remainingMinutes, 0)

  return {
    poolMinutes,
    poolConsumed,
    poolRemaining,
    packRemaining,
    packs: packs.map((p) => ({
      id: p.id,
      remainingMinutes: p.remainingMinutes,
      expiresAt: p.expiresAt,
      purchasedAt: p.purchasedAt,
    })),
    totalRemaining: poolRemaining + packRemaining,
    overageConsumed,
    cycleStart: billingAccount?.currentPeriodStart ?? null,
  }
}
