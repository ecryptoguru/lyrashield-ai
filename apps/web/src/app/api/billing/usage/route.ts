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

    const [balance, trialState, graceState, billingAccount] = await Promise.all([
      getUsageBalance(workspaceId),
      getTrialState(workspaceId),
      getGraceState(workspaceId),
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
