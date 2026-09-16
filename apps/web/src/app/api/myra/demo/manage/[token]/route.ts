/**
 * GET/POST /api/myra/demo/manage/[token] — ownership-checked booking manage.
 *
 * The manage token in the path IS the credential: the service compares its
 * hash to the booking and never accepts an arbitrary event id (spec §7).
 * GET reads the booking; POST applies the confirmed action
 * (cancel | reschedule) behind MYRA_WRITES_ENABLED.
 */
import { manageBooking } from "@lyrashield/myra/server"
import { manageDemoRequestSchema } from "@lyrashield/myra"
import { logger } from "@lyrashield/logger"
import { checkMyraRateLimit, clientIpFromRequest } from "@/lib/rate-limit"
import { assertSameOriginMutation, withApiRequest } from "@/lib/api-auth"
import {
  myraFail,
  myraNotFound,
  myraOk,
  myraPreflight,
  myraPublicEnabled,
  myraRateLimited,
  myraServiceFailure,
  myraWritesEnabled,
} from "../../../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

// Short human bound on the token segment — real tokens are long random
// strings; this only rejects obviously malformed paths before the hash lookup.
const TOKEN_MAX = 256

async function get(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
  if (!myraPublicEnabled()) return myraNotFound(request)

  const { token } = await params
  if (!token || token.length > TOKEN_MAX) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  const limit = await checkMyraRateLimit("message", clientIpFromRequest(request))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  try {
    // Booking reads flow through the same manageBooking entry point; "get"
    // performs no mutation and needs no writes gate.
    const booking = await manageBooking(token, "get")
    return myraOk(request, booking)
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra booking read failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not load that booking", 500)
  }
}

async function post(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
  if (!myraPublicEnabled() || !myraWritesEnabled()) return myraNotFound(request)

  const { token } = await params
  if (!token || token.length > TOKEN_MAX) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  // A booking-manage link can be opened while signed in; if the request
  // carries cookies it is a browser-session mutation and must be same-origin.
  if (request.headers.has("cookie")) {
    try {
      assertSameOriginMutation(request)
    } catch {
      return myraFail(request, "FORBIDDEN", "Forbidden", 403)
    }
  }

  const limit = await checkMyraRateLimit("message", clientIpFromRequest(request))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request body", 400)
  }
  const parsed = manageDemoRequestSchema.safeParse(body)
  if (!parsed.success) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  try {
    const booking = await manageBooking(token, parsed.data.action, parsed.data.newSlotStart)
    return myraOk(request, booking)
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra booking manage failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not update that booking", 500)
  }
}

export const GET = withApiRequest(get)
export const POST = withApiRequest(post)
