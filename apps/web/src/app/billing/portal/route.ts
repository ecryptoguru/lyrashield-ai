import { prisma } from "@lyrashield/db"
import { requireAuth } from "@lyrashield/auth/server"
import { getPolarPortalUrl } from "@lyrashield/billing"
import { env } from "@lyrashield/config"
import { apiError } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"

/**
 * GET /billing/portal — redirects to subscription management for
 * subscription management (upgrade, downgrade, cancel, update payment method).
 *
 * A-M07: Fixed from requirePermission("", ...) which always returned 401.
 * Now uses requireAuth() + findFirst for the user's workspace.
 */
export async function GET(_request: Request) {
  try {
    const session = await requireAuth()

    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: session.userId, status: "active" },
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
        return apiError("PROVIDER_NOT_CONFIGURED", "Polar portal is not configured.", 503)
      }
      return NextResponse.redirect(url)
    }

    // Razorpay has no self-serve subscription portal. Send customers to the
    // explicit billing-support path for cancellation and payment help.
    const marketingUrl = env.NEXT_PUBLIC_MARKETING_URL
    if (!marketingUrl) {
      logger.error("NEXT_PUBLIC_MARKETING_URL is not configured; cannot build billing support URL")
      return apiError("CONFIGURATION_ERROR", "Billing portal is not configured.", 503)
    }
    return NextResponse.redirect(
      `${marketingUrl.replace(/\/$/, "")}/support?topic=billing&provider=razorpay`
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Portal URL failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get portal URL", 500)
  }
}
