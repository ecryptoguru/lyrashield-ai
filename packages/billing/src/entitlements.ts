/**
 * Entitlement checks — the gate between billing state and scan/feature access.
 *
 * These functions are called by the scan-create API route and the worker
 * to determine whether a workspace is allowed to perform an action.
 */

import { prisma } from "@lyrashield/db"
import { CLOUD_PLAN_MAP, STANDARD_OVERAGE_PER_MINUTE_USD } from "@lyrashield/pricing"
import type { ScanMode } from "@lyrashield/types"
import { getUsageBalance } from "./usage/balance"
import { getTrialState, blockOnExpiry } from "./trial"
import { getGraceState as getGraceStateFromGrace } from "./grace"

export type ScanModeAllowed = "SAFE" | "QUICK" | "STANDARD" | "DEEP" | "CUSTOM"

export interface EntitlementResult {
  allowed: boolean
  /** Reason code if not allowed. */
  code?: string
  /** Human-readable message if not allowed. */
  message?: string
  /** Whether this is a trial workspace. */
  isTrial: boolean
  /** Current plan. */
  plan: string
  /** Remaining minutes. */
  remainingMinutes: number
}

/**
 * Assert that a scan with the given mode is allowed for this workspace.
 *
 * Rules:
 * - DEEP/CUSTOM scans require a plan with deepAllowed=true (PRO and above)
 * - TRIAL and STARTER plans cannot run DEEP/CUSTOM scans
 * - The workspace must have remaining agent-minutes > 0
 * - Trial workspaces may scan any target already admitted to the workspace
 */
export async function assertScanAllowed(
  workspaceId: string,
  mode: ScanMode
): Promise<EntitlementResult> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true, deepAllowed: true, trialStartedAt: true },
  })

  if (!workspace) {
    return {
      allowed: false,
      code: "WORKSPACE_NOT_FOUND",
      message: "Workspace not found",
      isTrial: false,
      plan: "FREE",
      remainingMinutes: 0,
    }
  }

  const plan = workspace.plan
  const cloudPlan = CLOUD_PLAN_MAP[plan as keyof typeof CLOUD_PLAN_MAP]
  const isTrial = plan === "FREE" && workspace.trialStartedAt !== null

  // A-L05: Call getTrialState once and reuse the result for both the
  // expiry check and the target-cap throttle check below.
  const trialState = isTrial ? await getTrialState(workspaceId) : null

  // Check trial expiry: if the workspace is on trial and the trial has expired,
  // block the scan and lazily set the billing account status via blockOnExpiry.
  if (isTrial && trialState?.isExpired) {
    // Lazily set the billing account status to "trial_expired"
    await blockOnExpiry(workspaceId).catch(() => {
      // Non-blocking — the scan is already blocked below
    })
    return {
      allowed: false,
      code: "TRIAL_EXPIRED",
      message: "Your trial has expired. Upgrade to continue scanning.",
      isTrial,
      plan,
      remainingMinutes: 0,
    }
  }

  // Check deep scan permission
  const isDeepMode = mode === "DEEP" || mode === "CUSTOM"
  if (isDeepMode) {
    // Check workspace.deepAllowed flag (set by the billing sync)
    if (!workspace.deepAllowed) {
      return {
        allowed: false,
        code: "DEEP_NOT_ALLOWED",
        message: "Deep is a Pro feature. Upgrade to Pro or Team to run Deep/Custom scans.",
        isTrial,
        plan,
        remainingMinutes: 0,
      }
    }
    // Also verify the plan supports deep
    if (cloudPlan && !cloudPlan.deepAllowed) {
      return {
        allowed: false,
        code: "DEEP_NOT_ALLOWED",
        message: "Deep is a Pro feature. Upgrade to Pro or Team to run Deep/Custom scans.",
        isTrial,
        plan,
        remainingMinutes: 0,
      }
    }
  }

  // Check usage balance
  const balance = await getUsageBalance(workspaceId)
  if (balance.totalRemaining <= 0) {
    // Check if overage is available (Launch Assurance plan with spend limit)
    const billingAccount = await prisma.billingAccount.findUnique({
      where: { workspaceId },
      select: {
        currentPlan: true,
        spendLimitCents: true,
        currentPeriodStart: true,
      },
    })
    const overagePlanEligible =
      billingAccount?.currentPlan === "LAUNCH_ASSURANCE" && (billingAccount.spendLimitCents ?? 0) > 0

    if (overagePlanEligible) {
      // S14: Also verify remaining overage spend budget > 0.
      // Query current cycle overage minutes and compute the remaining budget.
      const cycleStart = billingAccount?.currentPeriodStart ?? new Date(0)
      const overageRecords = await prisma.usageRecord.findMany({
        where: {
          workspaceId,
          kind: "overage_minutes",
          deletedAt: null,
          cycleStart: { gte: cycleStart },
        },
        select: { quantity: true },
      })
      const currentOverageMinutes = overageRecords.reduce((sum, r) => sum + r.quantity, 0)
      const overagePerMinuteCents = Math.round(STANDARD_OVERAGE_PER_MINUTE_USD * 100)
      const currentOverageCostCents = currentOverageMinutes * overagePerMinuteCents
      const remainingBudgetCents = (billingAccount?.spendLimitCents ?? 0) - currentOverageCostCents

      if (remainingBudgetCents <= 0) {
        return {
          allowed: false,
          code: "NO_MINUTES_REMAINING",
          message:
            "Your agent-minute balance is exhausted and your overage spend limit has been reached. Buy a minute pack or upgrade your plan.",
          isTrial,
          plan,
          remainingMinutes: 0,
        }
      }
    } else {
      return {
        allowed: false,
        code: "NO_MINUTES_REMAINING",
        message: isTrial
          ? "Your trial minutes are exhausted. Upgrade to continue scanning."
          : "Your agent-minute balance is exhausted. Buy a minute pack or upgrade your plan.",
        isTrial,
        plan,
        remainingMinutes: 0,
      }
    }
  }

  return {
    allowed: true,
    isTrial,
    plan,
    remainingMinutes: balance.totalRemaining,
  }
}

export interface TargetAllowedResult {
  allowed: boolean
  code?: string
  message?: string
  targetsUsed: number
  targetCap: number
}

/**
 * Assert that the workspace can add another target.
 * Each plan has a targetCaps limit (advisory, enforced for trial).
 */
export async function assertTargetAllowed(workspaceId: string): Promise<TargetAllowedResult> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true, trialStartedAt: true },
  })

  if (!workspace) {
    return {
      allowed: false,
      code: "WORKSPACE_NOT_FOUND",
      message: "Workspace not found",
      targetsUsed: 0,
      targetCap: 0,
    }
  }

  const isTrial = workspace.plan === "FREE" && workspace.trialStartedAt !== null
  const cloudPlan = CLOUD_PLAN_MAP[workspace.plan as keyof typeof CLOUD_PLAN_MAP]
  const targetCap = cloudPlan?.targetCaps ?? (isTrial ? 3 : 5)

  const targetCount = await prisma.target.count({
    where: { workspaceId, deletedAt: null },
  })

  // Hard cap for every plan. Workspaces already over their cap (e.g. after a
  // downgrade) keep all existing targets readable and scannable — only new
  // additions are blocked, and no target is ever silently deleted.
  if (targetCount >= targetCap) {
    const message = isTrial
      ? `Your trial allows up to ${targetCap} targets. Upgrade for more.`
      : `Your plan allows up to ${targetCap} protected targets. Remove a target or upgrade to add more.`
    return {
      allowed: false,
      code: "TARGET_LIMIT_REACHED",
      message,
      targetsUsed: targetCount,
      targetCap,
    }
  }

  return {
    allowed: true,
    targetsUsed: targetCount,
    targetCap,
  }
}

/**
 * Get the grace state for a workspace (used by the worker mid-scan).
 */
export async function getGraceState(workspaceId: string) {
  return getGraceStateFromGrace(workspaceId)
}
