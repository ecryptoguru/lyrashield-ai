import { z } from "zod"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import {
  resolveProvider,
  createPolarOneTimeCheckout,
  createRazorpayPaymentLink,
  MINUTE_PACK_MAP,
  type PackId,
  type BillingRegion,
} from "@lyrashield/billing"
import { apiError, apiSuccess } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"
import { logger } from "@lyrashield/logger"

const TopUpSchema = z.object({
  workspaceId: z.string().min(1),
  pack: z.enum(["pack_100", "pack_250", "pack_500"]),
  region: z.enum(["usd", "inr"]).optional(),
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
    return apiError("VALIDATION_ERROR", parsed.error.message, 400)
  }

  const { workspaceId, pack: packId } = parsed.data

  try {
    // Validate the caller has billing.manage on the specified workspace.
    // No findFirst fallback — the workspaceId must be explicitly provided.
    await requirePermission(workspaceId, PERMISSIONS.billing.manage)

    const pack = MINUTE_PACK_MAP[packId as PackId]
    if (!pack) {
      return apiError("INVALID_PACK", "Unknown minute pack", 400)
    }

    const override = parsed.data.region as BillingRegion | undefined
    const { provider } = resolveProvider(request, override)

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
    const successUrl = `${appUrl}/dashboard/billing?topup=success`
    const metadata = {
      workspaceId,
      packId,
    }

    if (provider === "polar") {
      // Polar: one-time checkout
      const productId = `polar_pack_${packId}`
      const url = await createPolarOneTimeCheckout({
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
      // Razorpay: payment link
      // Amount in paise (1 INR = 100 paise)
      // Convert USD price to INR at a fixed rate for now (production would use live rates)
      const amountInr = pack.priceUsd * 83 * 100 // approximate USD→INR conversion
      const result = await createRazorpayPaymentLink({
        amount: Math.round(amountInr),
        description: pack.name,
        notes: metadata,
        callbackUrl: successUrl,
      })

      if (!result) {
        return apiError(
          "PROVIDER_NOT_CONFIGURED",
          "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
          503
        )
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
