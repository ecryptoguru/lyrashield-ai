import { z } from "zod"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  createPolarCheckout,
  createRazorpaySubscription,
  getRazorpaySubscriptionCycleCount,
  resolveProviderId,
  CLOUD_PLAN_MAP,
  type CloudPlanId,
} from "@lyrashield/billing"
import { resolveAttribution } from "@lyrashield/affiliate"
import { apiSuccess, apiError } from "@/lib/api-response"
import { authErrorResponse, withCookieMutation } from "@/lib/api-auth"
import { checkBillingCheckoutRateLimit, claimBillingCheckoutCreation } from "@/lib/rate-limit"
import { env } from "@lyrashield/config"
import {
  billingAdmissionError,
  paymentsUnavailableError,
  resolveRequestBillingProvider,
} from "@/lib/billing-admission"

const CheckoutSchema = z
  .object({
    workspaceId: z.string().min(1),
    plan: z.enum(["STARTER", "PRO", "LAUNCH_ASSURANCE"]),
    interval: z.enum(["monthly", "annual"]),
    promoCode: z.string().max(100).optional(),
  })
  .strict()

async function post(request: Request) {
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

    // A-L04: Resolve provider — client-side region override removed to
    // prevent currency arbitrage. Region is determined server-side only.
    const { region, provider } = resolveRequestBillingProvider(request)
    const admissionError = billingAdmissionError(provider, workspaceId, request)
    if (admissionError) return admissionError

    // This endpoint creates subscriptions; paid plan/interval changes belong
    // to existing subscription management, including stale or direct callers.
    const [workspace, billingAccount] = await Promise.all([
      prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } }),
      prisma.billingAccount.findUnique({ where: { workspaceId }, select: { currentPlan: true } }),
    ])
    if (!workspace) return apiError("WORKSPACE_NOT_FOUND", "Workspace not found", 404)
    if (workspace.plan !== "FREE" || (billingAccount && billingAccount.currentPlan !== "FREE")) {
      return apiError(
        "SUBSCRIPTION_ALREADY_EXISTS",
        "Use Manage Subscription to update your existing subscription.",
        409
      )
    }

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
      const catalogKey = `${plan.toLowerCase()}_${interval}`
      const productId = resolveProviderId(env.POLAR_PRODUCT_IDS, catalogKey)
      if (!productId) {
        logger.error("Billing provider catalog is not configured", { provider, catalogKey })
        return paymentsUnavailableError()
      }
      const checkoutClaim = await claimBillingCheckoutCreation({
        workspaceId,
        provider,
        kind: "subscription",
        catalogKey,
      })
      if (checkoutClaim === "unavailable") return paymentsUnavailableError()
      if (checkoutClaim === "duplicate") {
        return apiError(
          "CHECKOUT_IN_PROGRESS",
          "A checkout is already being created. Please wait.",
          409
        )
      }
      const url = await createPolarCheckout({
        productId,
        successUrl,
        metadata,
      })

      if (!url) {
        logger.error("Billing provider checkout is unavailable", { provider, catalogKey })
        return paymentsUnavailableError()
      }

      return apiSuccess({ provider: "polar", url }, 200)
    } else {
      // Razorpay: create subscription
      const catalogKey = `${plan.toLowerCase()}_${interval}`
      const razorpayPlanId = resolveProviderId(env.RAZORPAY_PLAN_IDS, catalogKey)
      if (!razorpayPlanId) {
        logger.error("Billing provider catalog is not configured", { provider, catalogKey })
        return paymentsUnavailableError()
      }
      const checkoutClaim = await claimBillingCheckoutCreation({
        workspaceId,
        provider,
        kind: "subscription",
        catalogKey,
      })
      if (checkoutClaim === "unavailable") return paymentsUnavailableError()
      if (checkoutClaim === "duplicate") {
        return apiError(
          "CHECKOUT_IN_PROGRESS",
          "A checkout is already being created. Please wait.",
          409
        )
      }
      const totalCount = getRazorpaySubscriptionCycleCount(interval)
      const subscriptionId = await createRazorpaySubscription({
        planId: razorpayPlanId,
        totalCount,
        notes: metadata,
      })

      if (!subscriptionId) {
        logger.error("Billing provider checkout is unavailable", { provider, catalogKey })
        return paymentsUnavailableError()
      }

      return apiSuccess(
        {
          provider: "razorpay",
          subscriptionId,
          // Razorpay key IDs identify the account and are required by its
          // browser checkout; the API secret remains server-only.
          keyId: env.RAZORPAY_KEY_ID,
          region,
        },
        200
      )
    }
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Checkout failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create checkout session", 500)
  }
}

export const POST = withCookieMutation(post)
