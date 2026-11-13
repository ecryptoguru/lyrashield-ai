import type { ScopedTransaction } from "@lyrashield/db"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"
import { grantMonthlyPool } from "./usage/grants"
import { resetGrace } from "./grace"
import { resolveAllowanceCycle } from "./usage/allowance-cycle"
import type { SyncSubscriptionParams } from "./sync"

/** Subscription state, allowance and grace commit under the same account lock. */
export async function applySubscriptionAllowance(
  params: SyncSubscriptionParams,
  accountId: string,
  workspaceId: string | null,
  tx: ScopedTransaction,
  billingAccountId?: string
): Promise<void> {
  if (
    params.status !== "active" ||
    !params.currentPeriodStart ||
    CLOUD_PLAN_MAP[params.plan].agentMinutes <= 0
  )
    return
  const cycle = resolveAllowanceCycle({
    interval: params.interval,
    periodStart: params.currentPeriodStart,
    periodEnd: params.currentPeriodEnd ?? null,
  })
  const grant = await grantMonthlyPool({
    accountId,
    billingAccountId,
    workspaceId,
    plan: params.plan,
    cycleStart: cycle.cycleStart,
    source: params.interval === "annual" ? "annual_monthly" : "subscription",
    tx,
  })
  // A redelivery or same-cycle update must not erase already consumed grace.
  if (grant.created) await resetGrace(accountId, tx, cycle.cycleStart)
}
