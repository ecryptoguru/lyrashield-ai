import { prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { getPolarPortalUrl } from "@lyrashield/billing"
import { apiError, apiSuccess } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"
import { logger } from "@lyrashield/logger"

/**
 * GET /billing/portal — returns the Polar customer portal URL for
 * subscription management (upgrade, downgrade, cancel, update payment method).
 */
export async function GET(_request: Request) {
  try {
    const { session } = await requirePermission("", PERMISSIONS.billing.manage).catch(() => {
      throw new Error("UNAUTHORIZED")
    })

    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: session.userId },
      select: { workspaceId: true },
    })
    if (!membership) {
      return apiError("NO_WORKSPACE", "No workspace found for this user", 404)
    }

    const billingAccount = await prisma.billingAccount.findUnique({
      where: { workspaceId: membership.workspaceId },
      select: { externalId: true, provider: true },
    })

    if (!billingAccount || !billingAccount.externalId) {
      return apiError(
        "NO_SUBSCRIPTION",
        "No active subscription found. Subscribe to a plan first.",
        404
      )
    }

    if (billingAccount.provider === "polar") {
      const url = await getPolarPortalUrl({ customerId: billingAccount.externalId })
      if (!url) {
        return apiError(
          "PROVIDER_NOT_CONFIGURED",
          "Polar portal is not configured.",
          503
        )
      }
      return apiSuccess({ url }, 200)
    }

    // Razorpay doesn't have a self-serve portal — redirect to support
    return apiSuccess({
      url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing`,
      message: "Razorpay customers: manage your subscription from the dashboard or contact support.",
    }, 200)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Portal URL failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get portal URL", 500)
  }
}
