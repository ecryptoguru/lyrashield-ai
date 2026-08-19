/**
 * Monthly pool grants.
 *
 * When a subscription is activated or renewed, the workspace receives a
 * monthly pool of agent-minutes. Annual subscriptions grant the monthly
 * pool each month (not a lump-sum) — the reconciliation job triggers
 * monthly grants for active annual subs.
 *
 * Idempotency key: `{workspaceId}:{periodStart}:{plan}`
 */

import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { CLOUD_PLAN_MAP, type CloudPlanId } from "@lyrashield/pricing"

export type GrantSource = "subscription" | "annual_monthly" | "trial" | "manual"

export interface GrantMonthlyPoolResult {
  created: boolean
  minutes: number
  idempotencyKey: string
}

/**
 * Grant the monthly agent-minute pool for a workspace.
 *
 * For annual subscriptions, this is called once per month with the
 * periodStart set to the start of each billing month. The idempotency
 * key ensures each (workspace, period, plan) triple is granted exactly once.
 *
 * For trials, use `startTrial` in trial.ts which calls this with source="trial".
 */
export async function grantMonthlyPool(
  workspaceId: string,
  plan: CloudPlanId,
  periodStart: Date,
  source: GrantSource = "subscription"
): Promise<GrantMonthlyPoolResult> {
  const cloudPlan = CLOUD_PLAN_MAP[plan]
  if (!cloudPlan || cloudPlan.agentMinutes <= 0) {
    return { created: false, minutes: 0, idempotencyKey: "" }
  }

  const idempotencyKey = `${workspaceId}:${periodStart.toISOString()}:${plan}`

  const existing = await prisma.usageRecord.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  })
  if (existing) {
    return { created: false, minutes: 0, idempotencyKey }
  }

  const kind = source === "trial" ? "trial_grant" : "pool_grant"

  try {
    await prisma.usageRecord.create({
      data: {
        workspaceId,
        kind,
        quantity: cloudPlan.agentMinutes,
        idempotencyKey,
        cycleStart: periodStart,
        metadata: {
          plan,
          source,
          agentMinutes: cloudPlan.agentMinutes,
        },
      },
    })
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      logger.debug("Idempotent replay of grantMonthlyPool", { idempotencyKey })
      return { created: false, minutes: 0, idempotencyKey }
    }
    throw error
  }

  logger.info("Granted monthly pool", {
    workspaceId,
    plan,
    minutes: cloudPlan.agentMinutes,
    source,
    periodStart: periodStart.toISOString(),
  })

  return { created: true, minutes: cloudPlan.agentMinutes, idempotencyKey }
}
