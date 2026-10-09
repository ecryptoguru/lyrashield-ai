import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  createPolarOneTimeCheckout,
  createRazorpayPaymentLink,
  resolveProviderId,
  billingQuoteNotes,
} from "@lyrashield/billing"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { LOCAL_SKU_MAP } from "@lyrashield/pricing"
import { apiError, apiSuccess } from "@/lib/api-response"
import { checkBillingCheckoutRateLimit, clientIpFromRequest } from "@/lib/rate-limit"
import { localBillingAdmissionError, resolveRequestBillingProvider } from "@/lib/billing-admission"

const Body = z.object({}).strict()
const LOCAL_SKU = "individual_launch"

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Request body must be empty", 400)

  const { provider } = resolveRequestBillingProvider(request)
  const admissionError = localBillingAdmissionError(provider, request)
  if (admissionError) return admissionError

  const rateLimit = await checkBillingCheckoutRateLimit(`local:${clientIpFromRequest(request)}`)
  if (rateLimit.limited) {
    return apiError("RATE_LIMITED", "Too many checkout requests. Please try again later.", 429)
  }

  try {
    const referenceId = `local_${randomUUID()}`
    // Affiliate attribution is closed while new admission is frozen. No
    // affiliate_id or click_id is attached to the provider metadata. The
    // published Local billing path, its admission gate and its rate limiting
    // are unchanged.
    const metadata = {
      productId: LOCAL_SKU,
      referenceId,
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

    const amountMinor = Math.round(LOCAL_SKU_MAP[LOCAL_SKU].priceInr! * 100)
    const quoteNotes = billingQuoteNotes({
      provider: "razorpay",
      kind: "local",
      workspaceId: referenceId,
      catalogKey: LOCAL_SKU,
      amountMinor,
      currency: "INR",
    })
    const result = await createRazorpayPaymentLink({
      amount: amountMinor,
      description: "LyraShield AI Local — Individual Launch",
      notes: { ...metadata, quoteWorkspaceId: referenceId, ...quoteNotes },
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
