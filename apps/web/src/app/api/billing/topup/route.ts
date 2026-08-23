import { z } from "zod"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  resolveProvider,
  createPolarOneTimeCheckout,
  createRazorpayPaymentLink,
  resolveProviderId,
  MINUTE_PACK_MAP,
  type PackId,
} from "@lyrashield/billing"
import { apiError, apiSuccess } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { checkBillingCheckoutRateLimit } from "@/lib/rate-limit"
import { billingAdmissionError, paymentsUnavailableError } from "@/lib/billing-admission"

const TopUpSchema = z.object({
  workspaceId: z.string().min(1),
  pack: z.enum(["pack_100", "pack_250", "pack_500"]),
})

/**
 * POST /api/billing/topup — initiate a one-time minute pack purchase.
 *
 * Returns a Polar checkout URL or a Razorpay payment link,
 * geo-routed based on the client IP.
 */
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const parsed = TopUpSchema.safeParse(body)
  if (!parsed.success) {
    // A-L09: Don't leak Zod error details to clients
    logger.warn("Topup validation error", { errors: parsed.error.issues })
    return apiError("VALIDATION_ERROR", "Invalid request body", 400)
  }

  const { workspaceId, pack: packId } = parsed.data

  try {
    // Validate the caller has billing.manage on the specified workspace.
    // No findFirst fallback — the workspaceId must be explicitly provided.
    await requirePermission(workspaceId, PERMISSIONS.billing.manage)

    // A-M08: Rate limit topup creation per workspace
    const rateLimit = await checkBillingCheckoutRateLimit(workspaceId)
    if (rateLimit.limited) {
      return apiError("RATE_LIMITED", "Too many top-up requests. Please try again later.", 429)
    }

    const pack = MINUTE_PACK_MAP[packId as PackId]
    if (!pack) {
      return apiError("INVALID_PACK", "Unknown minute pack", 400)
    }

    // A-L04: Client-side region override removed — server-side geo routing only
    const { provider } = resolveProvider(request)
    const admissionError = billingAdmissionError(provider, workspaceId)
    if (admissionError) return admissionError

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
    const successUrl = `${appUrl}/dashboard/billing?topup=success`
    const metadata = {
      workspaceId,
      packId,
    }

    if (provider === "polar") {
      // Polar: one-time checkout
      const productId = resolveProviderId(env.POLAR_PRODUCT_IDS, packId)
      if (!productId) {
        logger.error("Billing provider catalog is not configured", { provider, packId })
        return paymentsUnavailableError()
      }
      const url = await createPolarOneTimeCheckout({
        productId,
        successUrl,
        metadata,
      })

      if (!url) {
        logger.error("Billing provider checkout is unavailable", { provider, packId })
        return paymentsUnavailableError()
      }

      return apiSuccess({ provider: "polar", url }, 200)
    } else {
      // Razorpay: payment link
      // Amount in paise (1 INR = 100 paise)
      // A-L02: Use configurable USD→INR rate instead of hardcoded 83
      const usdInrRate = env.BILLING_USD_INR_RATE
      const amountInr = pack.priceUsd * usdInrRate * 100
      const result = await createRazorpayPaymentLink({
        amount: Math.round(amountInr),
        description: pack.name,
        notes: metadata,
        callbackUrl: successUrl,
      })

      if (!result) {
        logger.error("Billing provider checkout is unavailable", { provider, packId })
        return paymentsUnavailableError()
      }

      return apiSuccess({ provider: "razorpay", url: result.url, id: result.id }, 200)
    }
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Top-up failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to initiate top-up", 500)
  }
}
