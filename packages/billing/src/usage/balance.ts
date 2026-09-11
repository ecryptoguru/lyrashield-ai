/**
 * Agent-minute usage balance — account-owned.
 *
 * The available balance for an account is:
 *   remaining = unexpired pack minutes + (current-cycle pool grant − current-cycle consumed)
 *
 * "Current cycle" is the account's allowance cycle (see allowance-cycle.ts):
 * the provider period for monthly plans, monthly anniversaries of the term
 * anchor for annual plans, and the trial window for trial accounts.
 *
 * Every read is scoped by `accountId`; `workspaceId` on ledger rows is
 * attribution and never widens or narrows the account's balance. Rows whose
 * accountId is still NULL (pre-backfill legacy) are not credited — the
 * backfill/exception procedure owns them.
 */

import { withAccountRLS, type ScopedTransaction } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { resolveAccountBilling, type ResolvedAccountBilling } from "../account"
import { resolveAllowanceCycle } from "./allowance-cycle"

export interface MinutePackBalance {
  id: string
  minutes: number
  remainingMinutes: number
  purchasedAt: Date
  expiresAt: Date | null
}

export interface UsageBalance {
  /** Pool minutes granted for the current allowance cycle. */
  poolMinutes: number
  /** Pool minutes consumed this cycle. */
  poolConsumed: number
  /** Pool minutes remaining this cycle (floored at 0). */
  poolRemaining: number
  /** Total pack minutes ever purchased (unexpired). */
  totalPackMinutes: number
  /** Minutes consumed that spilled into packs this cycle. */
  packConsumed: number
  /** Minutes remaining across unexpired packs. */
  packRemaining: number
  /** Total usable minutes (pool + packs). */
  totalRemaining: number
  /** Paid overage minutes consumed this cycle. */
  overageConsumed: number
  /** The allowance-cycle start bounding the pool. */
  cycleStart: Date | null
  /** Unexpired packs with balance. */
  packs: MinutePackBalance[]
}

const ZERO_BALANCE: UsageBalance = {
  poolMinutes: 0,
  poolConsumed: 0,
  poolRemaining: 0,
  totalPackMinutes: 0,
  packConsumed: 0,
  packRemaining: 0,
  totalRemaining: 0,
  overageConsumed: 0,
  cycleStart: null,
  packs: [],
}

type TxClient = ScopedTransaction

/** UsageRecord kinds that represent minute grants (pool or trial). */
const GRANT_KINDS = new Set(["pool_grant", "trial_grant"])

/** UsageRecord kinds that represent minute consumption. */
const CONSUME_KINDS = new Set(["agent_minutes", "overage_minutes"])

/**
 * Resolve the allowance-cycle start that bounds the account's pool.
 * Paid subscriptions use their current cycle; trial accounts use the trial
 * start (the trial grant's cycleStart). Accounts with neither have no pool.
 */
export function resolveBalanceCycleStart(input: {
  billing: Pick<
    ResolvedAccountBilling,
    "interval" | "currentPeriodStart" | "currentPeriodEnd"
  > | null
  trialStartedAt: Date | null
  at?: Date
}): Date | null {
  const at = input.at ?? new Date()
  if (input.billing?.currentPeriodStart) {
    return resolveAllowanceCycle({
      interval: input.billing.interval,
      periodStart: input.billing.currentPeriodStart,
      periodEnd: input.billing.currentPeriodEnd,
      at,
    }).cycleStart
  }
  return input.trialStartedAt ?? null
}

export async function getUsageBalanceForTx(
  tx: TxClient,
  input: {
    accountId: string
    billing: ResolvedAccountBilling | null
    trialStartedAt: Date | null
    at?: Date
  }
): Promise<UsageBalance> {
  const now = input.at ?? new Date()
  const cycleStart = resolveBalanceCycleStart({
    billing: input.billing,
    trialStartedAt: input.trialStartedAt,
    at: now,
  })

  const [packs, grantRecords, consumeRecords] = await Promise.all([
    tx.minutePack.findMany({
      where: {
        accountId: input.accountId,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
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
    // Pool/trial grants for the current cycle. No anchor → no pool at all.
    cycleStart
      ? tx.usageRecord.aggregate({
          where: {
            accountId: input.accountId,
            kind: { in: [...GRANT_KINDS] },
            deletedAt: null,
            cycleStart: { gte: cycleStart },
          },
          _sum: { quantity: true },
        })
      : Promise.resolve({ _sum: { quantity: null as number | null } }),
    cycleStart
      ? tx.usageRecord.groupBy({
          by: ["kind"],
          where: {
            accountId: input.accountId,
            kind: { in: [...CONSUME_KINDS] },
            deletedAt: null,
            cycleStart: { gte: cycleStart },
          },
          _sum: { quantity: true },
        })
      : Promise.resolve([] as { kind: string; _sum: { quantity: number | null } }[]),
  ])

  const poolMinutes = grantRecords._sum.quantity ?? 0
  const poolConsumed = consumeRecords.find((r) => r.kind === "agent_minutes")?._sum.quantity ?? 0
  const overageConsumed =
    consumeRecords.find((r) => r.kind === "overage_minutes")?._sum.quantity ?? 0

  // Overage is consumed AFTER pool + packs, so it does NOT reduce pool remaining.
  const poolRemaining = Math.max(0, poolMinutes - poolConsumed)

  // Pack consumption spills in only after the pool is exhausted. The
  // MinutePack.remainingMinutes column (decremented atomically by
  // recordAgentMinutes) is the source of truth — not cycle-scoped records.
  const packConsumed = Math.max(0, poolConsumed - poolMinutes)
  const totalPackMinutes = packs.reduce((sum, p) => sum + p.minutes, 0)
  const packRemaining = packs.reduce((sum, p) => sum + Math.max(0, p.remainingMinutes), 0)

  logger.debug("Computed usage balance", {
    accountId: input.accountId,
    poolMinutes,
    poolConsumed,
    poolRemaining,
    packRemaining,
    cycleStart: cycleStart?.toISOString() ?? null,
  })

  return {
    poolMinutes,
    poolConsumed,
    poolRemaining,
    totalPackMinutes,
    packConsumed,
    packRemaining,
    totalRemaining: poolRemaining + packRemaining,
    overageConsumed,
    cycleStart,
    packs: packs.map((p) => ({
      id: p.id,
      minutes: p.minutes,
      remainingMinutes: Math.max(0, p.remainingMinutes),
      expiresAt: p.expiresAt,
      purchasedAt: p.purchasedAt,
    })),
  }
}

async function accountTrialStart(accountId: string, tx: TxClient): Promise<Date | null> {
  const user = await tx.user.findUnique({
    where: { id: accountId },
    select: { trialStartedAt: true },
  })
  return user?.trialStartedAt ?? null
}

/**
 * Prefetched rows for `getUsageBalance` — the billing page and usage route
 * already read the account's BillingAccount and the User trial state for
 * their own rendering (Deep Review v16 2.1: no duplicate reads).
 */
export interface UsageBalancePrefetched {
  billing?: ResolvedAccountBilling | null
  trialStartedAt?: Date | null
}

/**
 * The account's current usage balance. Runs under the account RLS context.
 */
export async function getUsageBalance(
  accountId: string,
  prefetched?: UsageBalancePrefetched
): Promise<UsageBalance> {
  return withAccountRLS(accountId, async (tx) => {
    const [billing, trialStartedAt] = await Promise.all([
      prefetched?.billing !== undefined
        ? Promise.resolve(prefetched.billing)
        : resolveAccountBilling(accountId, tx),
      prefetched?.trialStartedAt !== undefined
        ? Promise.resolve(prefetched.trialStartedAt)
        : accountTrialStart(accountId, tx),
    ])
    if (!billing && !trialStartedAt) return ZERO_BALANCE
    return getUsageBalanceForTx(tx, { accountId, billing, trialStartedAt })
  })
}
