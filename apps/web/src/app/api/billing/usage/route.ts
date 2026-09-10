import { prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { getUsageBalance, getTrialState, getGraceState } from "@lyrashield/billing"
import { apiError, apiSuccess } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"
import { logger } from "@lyrashield/logger"

/**
 * GET /api/billing/usage — returns the workspace's current usage state.
 *
 * Returns: usage balance (minutes used/pool, targets used/cap), trial state,
 * unexpired packs with expiry dates, and grace state.
 *
 * NOTE: No $ cost/spend values are returned — the dashboard does not display
 * monetary amounts per the billing design constraint.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.billing.manage)

    // 2.1: fetch BillingAccount and Workspace once and pass the rows into the
    // balance/trial/grace helpers instead of each helper re-reading them.
    const [billingAccount, workspaceRow] = await Promise.all([
      prisma.billingAccount.findUnique({
        where: { workspaceId },
        select: {
          currentPlan: true,
          status: true,
          interval: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
        },
      }),
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          plan: true,
          trialStartedAt: true,
          graceUsedMs: true,
          graceCycleStart: true,
        },
      }),
    ])

    const [balance, trialState, graceState] = await Promise.all([
      getUsageBalance(workspaceId, {
        billingAccount: billingAccount
          ? {
              currentPeriodStart: billingAccount.currentPeriodStart,
              currentPlan: billingAccount.currentPlan,
            }
          : null,
        workspace: workspaceRow ? { trialStartedAt: workspaceRow.trialStartedAt } : null,
      }),
      getTrialState(
        workspaceId,
        workspaceRow
          ? { plan: workspaceRow.plan, trialStartedAt: workspaceRow.trialStartedAt }
          : null
      ),
      getGraceState(
        workspaceId,
        workspaceRow
          ? { graceUsedMs: workspaceRow.graceUsedMs, graceCycleStart: workspaceRow.graceCycleStart }
          : null
      ),
    ])

    return apiSuccess(
      {
        plan: billingAccount?.currentPlan ?? "FREE",
        status: billingAccount?.status ?? "free",
        interval: billingAccount?.interval ?? null,
        currentPeriodStart: billingAccount?.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: billingAccount?.currentPeriodEnd?.toISOString() ?? null,
        usage: {
          poolMinutes: balance.poolMinutes,
          poolConsumed: balance.poolConsumed,
          poolRemaining: balance.poolRemaining,
          packRemaining: balance.packRemaining,
          totalRemaining: balance.totalRemaining,
          packs: balance.packs.map((p) => ({
            id: p.id,
            remainingMinutes: p.remainingMinutes,
            expiresAt: p.expiresAt?.toISOString() ?? null,
            purchasedAt: p.purchasedAt.toISOString(),
          })),
        },
        trial: {
          isActive: trialState.isActive,
          isExpired: trialState.isExpired,
          startedAt: trialState.startedAt?.toISOString() ?? null,
          endsAt: trialState.endsAt?.toISOString() ?? null,
          daysLeft: trialState.daysLeft,
          minutesLeft: trialState.minutesLeft,
          targetsUsed: trialState.targetsUsed,
          targetCap: trialState.targetCap,
        },
        grace: {
          inGrace: graceState.inGrace,
          usedMs: graceState.usedMs,
          remainingMs: graceState.remainingMs,
          exceeded: graceState.exceeded,
        },
      },
      200
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Usage query failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get usage state", 500)
  }
}
