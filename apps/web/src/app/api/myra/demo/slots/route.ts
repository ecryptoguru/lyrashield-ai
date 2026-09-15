/**
 * POST /api/myra/demo/slots — bounded bookable demo slots (spec §7).
 *
 * Public read shared by the Myra panel and the standalone /demo page. Slot
 * generation hits the calendar provider's free/busy lookup, so it is
 * rate-limited even though it carries no principal requirement.
 */
import { getDemoSlots, resolveMyraRequest } from "@lyrashield/myra/server"
import { demoSlotsRequestSchema } from "@lyrashield/myra"
import { logger } from "@lyrashield/logger"
import { checkMyraRateLimit, clientIpFromRequest } from "@/lib/rate-limit"
import { withApiRequest } from "@/lib/api-auth"
import {
  myraFail,
  myraNotFound,
  myraOk,
  myraPreflight,
  myraPublicEnabled,
  myraRateLimitKey,
  myraRateLimited,
  myraServiceFailure,
} from "../../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function post(request: Request): Promise<Response> {
  if (!myraPublicEnabled()) return myraNotFound(request)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request body", 400)
  }
  const parsed = demoSlotsRequestSchema.safeParse(body)
  if (!parsed.success) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  // Optional resolve: a public session (or cookie session) refines the
  // rate-limit key; unauthenticated callers are bounded by client IP.
  const resolved = await resolveMyraRequest(request)
  const key = resolved ? myraRateLimitKey(resolved.principal) : clientIpFromRequest(request)
  const limit = await checkMyraRateLimit("message", key)
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  try {
    const result = await getDemoSlots(parsed.data.timezone, parsed.data.from)
    return myraOk(request, result)
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra demo slots failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not load demo slots", 500)
  }
}

export const POST = withApiRequest(post)
