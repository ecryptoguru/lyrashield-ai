/**
 * Monthly minute-pool grants.
 *
 * Grants are account-owned: the idempotency key is
 * `{accountId}:{cycleStartIso}:{plan}` — exactly one pool per account per
 * allowance cycle per plan, whether the trigger is a webhook, a replay, the
 * replenishment job, or a manual reconciliation. `workspaceId` remains on the
 * row as attribution only.
 *
 * Rollout compatibility (expand–contract): rows written by the previous
 * image used the legacy key `{workspaceId}:{periodStartIso}:{plan}` where the
 * period start equals the cycle start for that cycle. `grantMonthlyPool`
 * probes that legacy key (built from the grant's attribution workspace)
 * before writing, so an old-binary grant made mid-rollout is never
 * duplicated; the new key guarantees the new binary cannot double-grant
 * either. Neither representation can independently grant.
 */

import { withAccountRLS, withWorkspaceRLS, type ScopedTransaction } from "@lyrashield/db"
import { CLOUD_PLAN_MAP, type CloudPlanId } from "@lyrashield/pricing"
import { logger } from "@lyrashield/logger"

export type GrantSource = "subscription" | "annual_monthly" | "trial" | "manual" | "replenishment"

export interface GrantMonthlyPoolResult {
  created: boolean
  minutes: number
  idempotencyKey: string
}

type DbClient = ScopedTransaction

export function monthlyPoolGrantKey(
  accountId: string,
  cycleStart: Date,
  plan: CloudPlanId
): string {
  return `${accountId}:${cycleStart.toISOString()}:${plan}`
}

/** Pre-account-ownership key shape. Kept so old-binary grants are never duplicated. */
export function legacyMonthlyPoolGrantKey(
  workspaceId: string,
  periodStart: Date,
  plan: CloudPlanId
): string {
  return `${workspaceId}:${periodStart.toISOString()}:${plan}`
}

export interface MonthlyPoolGrantParams {
  /** Owning account — the balance this pool credits. */
  accountId: string
  /** Exact originating contract, for scoped reversal and audit. */
  billingAccountId?: string
  /** Attribution workspace (billing row's workspace, or purchase context). */
  workspaceId: string | null
  plan: CloudPlanId
  /** The allowance-cycle start this pool covers (not the raw provider period). */
  cycleStart: Date
  source: GrantSource
  /**
   * Optional pre-bound transaction. When supplied the caller owns the RLS
   * context; the account context must already include `accountId`.
   */
  tx?: DbClient
}

/**
 * Grant the plan's monthly minute pool for one allowance cycle.
 * Idempotent: the unique idempotency key is the concurrency arbiter.
 */
export async function grantMonthlyPool(
  params: MonthlyPoolGrantParams
): Promise<GrantMonthlyPoolResult> {
  const planMinutes = CLOUD_PLAN_MAP[params.plan]?.agentMinutes ?? 0
  if (planMinutes <= 0) {
    return { created: false, minutes: 0, idempotencyKey: "" }
  }
  const idempotencyKey = monthlyPoolGrantKey(params.accountId, params.cycleStart, params.plan)
  const legacyKey = params.workspaceId
    ? legacyMonthlyPoolGrantKey(params.workspaceId, params.cycleStart, params.plan)
    : null

  const create = async (tx: DbClient) => {
    // Serialize grants for the same account across concurrent webhooks and
    // the replenishment job. The previous image took no lock; the unique key
    // remains the race arbiter for old binaries.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pool:${params.accountId}`}, 0))`

    // Legacy rows are workspace-attributed with accountId NULL — visible only
    // through the workspace policy, which is why the workspace context must
    // be bound alongside the account context for this probe.
    const existing = await tx.usageRecord.findFirst({
      where: {
        accountId: params.accountId,
        idempotencyKey: { in: [idempotencyKey, ...(legacyKey ? [legacyKey] : [])] },
      },
      select: { id: true },
    })
    if (existing) return { created: false, minutes: 0, idempotencyKey }

    try {
      await tx.usageRecord.create({
        data: {
          workspaceId: params.workspaceId,
          accountId: params.accountId,
          kind: "pool_grant",
          quantity: planMinutes,
          idempotencyKey,
          cycleStart: params.cycleStart,
          metadata: {
            ...(params.billingAccountId ? { billingAccountId: params.billingAccountId } : {}),
            plan: params.plan,
            source: params.source,
            accountId: params.accountId,
            cycleStart: params.cycleStart.toISOString(),
          },
        },
      })
      return { created: true, minutes: planMinutes, idempotencyKey }
    } catch (error) {
      // Unique-key race: a concurrent delivery granted first.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      ) {
        return { created: false, minutes: 0, idempotencyKey }
      }
      throw error
    }
  }

  const result = params.tx
    ? await create(params.tx)
    : params.workspaceId === null
      ? await withAccountRLS(params.accountId, create)
      : await withWorkspaceRLS(params.workspaceId, (tx) => create(tx), {
          accountId: params.accountId,
        })

  if (result.created) {
    logger.info("Granted monthly minute pool", {
      accountId: params.accountId,
      workspaceId: params.workspaceId,
      plan: params.plan,
      cycleStart: params.cycleStart.toISOString(),
      source: params.source,
      minutes: planMinutes,
    })
  } else {
    logger.debug("Monthly pool grant already exists", {
      accountId: params.accountId,
      cycleStart: params.cycleStart.toISOString(),
      plan: params.plan,
    })
  }
  return result
}
