import type { ScopedTransaction } from "@lyrashield/db"
import { resolveAccountBilling } from "../account"
import { resolveAllowanceCycle } from "./allowance-cycle"
import type { MonthlyPoolGrantParams } from "./grants"

/** Sweep snapshots are advisory; the current governing contract decides under lock. */
export async function isCurrentPoolGrant(
  params: MonthlyPoolGrantParams,
  tx: ScopedTransaction
): Promise<boolean> {
  if (!params.billingAccountId) return true
  const billing = await resolveAccountBilling(params.accountId, tx)
  if (
    !billing ||
    billing.id !== params.billingAccountId ||
    billing.effectivePlan !== params.plan ||
    !billing.currentPeriodStart
  )
    return false
  const now = new Date()
  if (
    now < billing.currentPeriodStart ||
    (billing.currentPeriodEnd && now >= billing.currentPeriodEnd)
  )
    return false
  const cycle = resolveAllowanceCycle({
    interval: billing.interval,
    periodStart: billing.currentPeriodStart,
    periodEnd: billing.currentPeriodEnd,
    at: now,
  })
  return cycle.cycleStart.getTime() === params.cycleStart.getTime()
}

/** Restore the exact retired pool, excluding rows attributed to another contract. */
export async function restoreContractPool(
  params: MonthlyPoolGrantParams,
  idempotencyKey: string,
  legacyKey: string | null,
  tx: ScopedTransaction
) {
  await tx.$executeRaw`
    UPDATE "UsageRecord" SET "deletedAt" = NULL
    WHERE "accountId" = ${params.accountId} AND "kind" = 'pool_grant'
      AND "cycleStart" = ${params.cycleStart} AND "deletedAt" IS NOT NULL
      AND ("idempotencyKey" = ${idempotencyKey} OR "idempotencyKey" = ${legacyKey})
      AND "metadata"->>'source' IN ('subscription', 'annual_monthly', 'replenishment')
      AND ("metadata"->>'billingAccountId' IS NULL OR "metadata"->>'billingAccountId' = ${params.billingAccountId})`
}
