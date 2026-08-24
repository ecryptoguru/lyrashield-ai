import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { PERMISSIONS } from "@lyrashield/auth"
import { requirePermission } from "@lyrashield/auth/server"
import { getPolarPortalUrl } from "@lyrashield/billing"
import { env } from "@lyrashield/config"
import { apiError } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"
import { logger } from "@lyrashield/logger"
import { NextResponse } from "next/server"

const WorkspaceIdSchema = z.string().trim().min(1).max(128)

/**
 * GET /billing/portal — redirects to subscription management
 * (upgrade, downgrade, cancel, update payment method).
 *
 * Requires an explicit workspace and billing management permission. Never
 * infer a workspace from membership order for this sensitive redirect.
 */
export async function GET(request: Request) {
  const parsedWorkspaceId = WorkspaceIdSchema.safeParse(
    new URL(request.url).searchParams.get("workspaceId")
  )
  if (!parsedWorkspaceId.success) {
    return apiError("VALIDATION_ERROR", "A valid workspaceId is required", 400)
  }
  const workspaceId = parsedWorkspaceId.data

  try {
    await requirePermission(workspaceId, PERMISSIONS.billing.manage)

    const billingAccount = await prisma.billingAccount.findUnique({
      where: { workspaceId },
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
