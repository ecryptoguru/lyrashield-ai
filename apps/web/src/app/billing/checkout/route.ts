import { z } from "zod"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  resolveProvider,
  createPolarCheckout,
  createRazorpaySubscription,
  CLOUD_PLAN_MAP,
  type CloudPlanId,
  type BillingRegion,
} from "@lyrashield/billing"
import { resolveAttribution } from "@lyrashield/affiliate"
import { apiSuccess, apiError } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"

const CheckoutSchema = z.object({
  plan: z.enum(["STARTER", "PRO", "TEAM"]),
  interval: z.enum(["monthly", "annual"]),
  region: z.enum(["usd", "inr"]).optional(),
  promoCode: z.string().max(100).optional(),
})

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const parsed = CheckoutSchema.safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", parsed.error.message, 400)
  }

  const { plan, interval, promoCode } = parsed.data

  try {
    // Get workspace from session
    const { session } = await requirePermission("", PERMISSIONS.billing.manage).catch(() => {
      throw new Error("UNAUTHORIZED")
    })

    // Get the user's workspace
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: session.userId },
      select: { workspaceId: true },
    })
    if (!membership) {
      return apiError("NO_WORKSPACE", "No workspace found for this user", 404)
    }

    const workspaceId = membership.workspaceId

    // Verify the plan is self-serve
    const cloudPlan = CLOUD_PLAN_MAP[plan as CloudPlanId]
    if (!cloudPlan || !cloudPlan.selfServe) {
      return apiError("INVALID_PLAN", "This plan does not support self-serve checkout", 400)
    }

    // Resolve provider (geo-routed or manual override)
    const override = parsed.data.region as BillingRegion | undefined
    const { region, provider } = resolveProvider(request, override)

    // Track C integration: resolve affiliate promo code → attach affiliate metadata.
    // No commission created at checkout — only on the paid webhook (per affiliate brief).
    let affiliateMetadata: Record<string, string> = {}
    if (promoCode) {
      try {
        const attribution = await resolveAttribution({ promoCode })
        if (attribution && attribution.affiliateId) {
          affiliateMetadata = {
            affiliate_id: attribution.affiliateId,
            ...(attribution.clickId ? { click_id: attribution.clickId } : {}),
            promo_code: promoCode,
          }
          logger.info("Affiliate promo code resolved at checkout", {
            promoCode,
            affiliateId: attribution.affiliateId,
          })
        } else {
          logger.info("Promo code not recognized as affiliate code", { promoCode })
        }
      } catch (err) {
        // Non-blocking — affiliate resolution failure should not block checkout
        logger.error("Affiliate promo code resolution failed (non-blocking)", {
          promoCode,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
    const successUrl = `${appUrl}/dashboard/billing?checkout=success`
    const metadata = {
      workspaceId,
      plan,
      interval,
      ...(promoCode ? { promoCode } : {}),
      ...affiliateMetadata,
    }

    if (provider === "polar") {
      // Polar: create hosted checkout
      // In production, the productId maps to a Polar product configured in the dashboard.
      // For now, we use a convention: polar_product_{plan}_{interval}
      const productId = `polar_product_${plan.toLowerCase()}_${interval}`
      const url = await createPolarCheckout({
        productId,
        successUrl,
        metadata,
      })

      if (!url) {
        return apiError(
          "PROVIDER_NOT_CONFIGURED",
          "Polar is not configured. Set POLAR_ACCESS_TOKEN.",
          503
        )
      }

      return apiSuccess({ provider: "polar", url }, 200)
    } else {
      // Razorpay: create subscription
      // In production, the planId maps to a Razorpay plan configured in the dashboard.
      const razorpayPlanId = `razorpay_plan_${plan.toLowerCase()}_${interval}`
      const totalCount = interval === "annual" ? 12 : 1
      const subscriptionId = await createRazorpaySubscription({
        planId: razorpayPlanId,
        totalCount,
        notes: metadata,
      })

      if (!subscriptionId) {
        return apiError(
          "PROVIDER_NOT_CONFIGURED",
          "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
          503
        )
      }

      return apiSuccess({ provider: "razorpay", subscriptionId, region }, 200)
    }
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Checkout failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create checkout session", 500)
  }
}
