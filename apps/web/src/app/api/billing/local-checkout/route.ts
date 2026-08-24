import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  createPolarOneTimeCheckout,
  createRazorpayPaymentLink,
  resolveProvider,
  resolveProviderId,
} from "@lyrashield/billing"
import { parseAffiliateCookie, resolveAttribution } from "@lyrashield/affiliate"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { LOCAL_SKU_MAP } from "@lyrashield/pricing"
import { apiError, apiSuccess } from "@/lib/api-response"
import { checkBillingCheckoutRateLimit, clientIpFromRequest } from "@/lib/rate-limit"

const Body = z.object({}).strict()
const LOCAL_SKU = "individual_launch"

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Request body must be empty", 400)

  const { provider } = resolveProvider(request)
  const admission =
    provider === "polar" ? env.POLAR_LOCAL_BILLING_ADMISSION : env.RAZORPAY_LOCAL_BILLING_ADMISSION
  if (admission !== "public") {
    return apiError("PAYMENTS_UNAVAILABLE", "Local purchases are temporarily unavailable.", 503)
  }

  const rateLimit = await checkBillingCheckoutRateLimit(`local:${clientIpFromRequest(request)}`)
  if (rateLimit.limited) {
    return apiError("RATE_LIMITED", "Too many checkout requests. Please try again later.", 429)
  }

  try {
    const referenceId = `local_${randomUUID()}`
    const attribution = await resolveAttribution({
      cookieToken: parseAffiliateCookie(request.headers.get("cookie")),
    })
    const metadata = {
      productId: LOCAL_SKU,
      referenceId,
      ...(attribution.affiliateId ? { affiliate_id: attribution.affiliateId } : {}),
      ...(attribution.clickId ? { click_id: attribution.clickId } : {}),
    }
    const appUrl = env.NEXT_PUBLIC_APP_URL || "https://app.lyrashieldai.com"
    const successUrl = `${appUrl}/buy/local?status=received`

    if (provider === "polar") {
      const productId = resolveProviderId(env.POLAR_LOCAL_PRODUCT_IDS, LOCAL_SKU)
      if (!productId) throw new Error("local_catalog_unavailable")
      const url = await createPolarOneTimeCheckout({ productId, successUrl, metadata })
      if (!url) throw new Error("local_provider_unavailable")
      return apiSuccess({ provider, url }, 200)
    }

    const result = await createRazorpayPaymentLink({
      amount: LOCAL_SKU_MAP[LOCAL_SKU].priceInr! * 100,
      description: "LyraShield AI Local — Individual Launch",
      notes: metadata,
      callbackUrl: successUrl,
      referenceId,
      partialPayment: false,
    })
    if (!result) throw new Error("local_provider_unavailable")
    return apiSuccess({ provider, url: result.url }, 200)
  } catch (error) {
    logger.error("Local checkout creation failed", {
      provider,
      reason: error instanceof Error ? error.message : "unknown",
    })
    return apiError("PAYMENTS_UNAVAILABLE", "Local purchases are temporarily unavailable.", 503)
  }
}
