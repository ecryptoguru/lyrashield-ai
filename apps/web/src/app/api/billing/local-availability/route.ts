import { getLocalBillingAdmission } from "@lyrashield/billing"
import { logger } from "@lyrashield/logger"
import { isPublicOriginAllowed, publicPreflight, publicResponse } from "@/lib/public-cors"
import { resolveRequestBillingProvider } from "@/lib/billing-admission"
import { checkApiRateLimit, clientIpFromRequest } from "@/lib/rate-limit"

export const dynamic = "force-dynamic"

/**
 * GET /api/billing/local-availability — read-only display state for the
 * marketing pricing page. Resolves the request's payment provider exactly as
 * checkout does (proxy-authenticated country → region → provider, unknown
 * regions fail closed to USD/Polar) and returns only whether Local purchases
 * are open for that provider.
 *
 * This endpoint changes nothing: it is an availability hint for pricing-page
 * rendering. /buy/local and /api/billing/local-checkout remain authoritative
 * and re-check admission server-side on every attempt.
 */
export async function GET(request: Request) {
  // Same-origin requests carry no Origin header — allow them; foreign origins
  // are answered without CORS headers so browsers withhold the body.
  const origin = request.headers.get("origin")
  if (origin && !isPublicOriginAllowed(request)) {
    return publicResponse(request, { error: "forbidden" }, 403)
  }

  const rateLimit = await checkApiRateLimit(clientIpFromRequest(request))
  if (rateLimit.limited) {
    return publicResponse(request, { error: "rate_limited" }, 429)
  }

  try {
    const { provider } = resolveRequestBillingProvider(request)
    const admission = getLocalBillingAdmission(provider)
    return publicResponse(request, { provider, available: admission.allowed }, 200)
  } catch (error) {
    logger.error("Failed to resolve local purchase availability", {
      error: error instanceof Error ? error.name : "unknown",
    })
    return publicResponse(request, { error: "availability_unconfirmed" }, 500)
  }
}

export function OPTIONS(request: Request): Response {
  return publicPreflight(request)
}
