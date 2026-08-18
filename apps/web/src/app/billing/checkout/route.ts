import { z } from "zod"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
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
import { checkBillingCheckoutRateLimit } from "@/lib/rate-limit"

const CheckoutSchema = z.object({
  workspaceId: z.string().min(1),
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
    // A-L09: Don't leak Zod error details to clients — log server-side only
    logger.warn("Checkout validation error", { errors: parsed.error.issues })
    return apiError("VALIDATION_ERROR", "Invalid request body", 400)
  }

  const { workspaceId, plan, interval, promoCode } = parsed.data

  try {
    // Validate the caller has billing.manage on the specified workspace.
    // No findFirst fallback — the workspaceId must be explicitly provided.
    await requirePermission(workspaceId, PERMISSIONS.billing.manage)

    // A-M08: Rate limit checkout creation per workspace
    const rateLimit = await checkBillingCheckoutRateLimit(workspaceId)
    if (rateLimit.limited) {
      return apiError("RATE_LIMITED", "Too many checkout requests. Please try again later.", 429)
    }

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
