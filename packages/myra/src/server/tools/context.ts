/**
 * get_my_context — minimal effective-entitlement summary for the caller's
 * OWN account. Account-owned billing only: resolveAccountBilling /
 * getAccountTrialState / getUsageBalance — never workspace.plan.
 */
import { z } from "zod"
import { withAccountRLS, withWorkspaceRLS } from "@lyrashield/db"
import {
  evaluateScanEntitlement,
  getAccountTrialState,
  getUsageBalance,
  resolveAccountBilling,
} from "@lyrashield/billing"
import { CLOUD_PLAN_MAP } from "@lyrashield/pricing"
import type { CloudPlanId } from "@lyrashield/pricing"
import { err } from "../errors"
import type { MyraToolContext, MyraToolResult } from "./types"

export const getMyContextInput = z.object({}).strict()

export async function runGetMyContext(
  ctx: MyraToolContext,
  _input: unknown
): Promise<MyraToolResult> {
  if (ctx.principal.kind !== "user") throw err("UNAUTHORIZED", "Sign in to see your account.")
  const accountId = ctx.principal.accountId

  const deps = {
    resolveAccountBilling: ctx.deps?.resolveAccountBilling ?? resolveAccountBilling,
    getAccountTrialState: ctx.deps?.getAccountTrialState ?? getAccountTrialState,
    getUsageBalance: ctx.deps?.getUsageBalance ?? getUsageBalance,
    evaluateScanEntitlement:
      ctx.deps?.evaluateScanEntitlement ?? evaluateScanEntitlement,
  }

  // An injected db (tests/evals) is already the scoped view — skip the RLS
  // transaction wrapper so no real connection is opened.
  const summary = ctx.db
    ? await (async () => {
        const [billing, trial] = await Promise.all([
          deps.resolveAccountBilling(accountId, ctx.db!),
          deps.getAccountTrialState(accountId),
        ])
        const balance = await deps
          .getUsageBalance(accountId, {
            billing,
            trialStartedAt: trial.startedAt,
          })
          .catch(() => null)
        return { billing, trial, balance }
      })()
    : await withAccountRLS(accountId, async (tx) => {
        const [billing, trial] = await Promise.all([
          deps.resolveAccountBilling(accountId, tx),
          deps.getAccountTrialState(accountId),
        ])
        const balance = await deps
          .getUsageBalance(accountId, {
            billing,
            trialStartedAt: trial.startedAt,
          })
          .catch(() => null)
        return { billing, trial, balance }
      })

  const plan = summary.billing?.effectivePlan ?? "FREE"
  const cloudPlan = CLOUD_PLAN_MAP[plan as CloudPlanId]

  let targetCount: number | null = null
  let canScan = false
  if (ctx.workspaceId) {
    const workspaceId = ctx.workspaceId
    targetCount = ctx.db
      ? await ctx.db.target
          .count({ where: { workspaceId, deletedAt: null } })
          .catch(() => null)
      : await withWorkspaceRLS(
          workspaceId,
          (tx) => tx.target.count({ where: { workspaceId, deletedAt: null } }),
          { accountId }
        ).catch(() => null)
    const entitlement = await deps
      .evaluateScanEntitlement({
        workspaceId,
        mode: "STANDARD",
        sponsorAccountId: accountId,
      })
      .catch(() => null)
    canScan = entitlement?.allowed ?? false
  } else {
    canScan = (summary.balance?.totalRemaining ?? 0) > 0 && !summary.trial.isExpired
  }

  return {
    data: {
      checkedAt: new Date().toISOString(),
      plan,
      planName: cloudPlan?.name ?? "Free",
      isTrial: summary.trial.isActive,
      trialExpired: summary.trial.isExpired,
      trialDaysLeft: summary.trial.daysLeft,
      minutesRemaining: summary.balance?.totalRemaining ?? summary.trial.minutesLeft,
      targetCount,
      targetCap: summary.trial.isActive
        ? summary.trial.targetCap
        : (cloudPlan?.targetCaps ?? null),
      canScan,
    },
  }
}
