/**
 * GET /api/myra/cases — list the caller's own support cases.
 *
 * Ownership is resolved by the service: accountId for browser sessions,
 * publicSessionId for anonymous public sessions. Case creation is NOT here —
 * it goes through /api/myra/proposals/confirm (the confirmed-write path).
 */
import { listOwnCases, resolveMyraRequest } from "@lyrashield/myra/server"
import { logger } from "@lyrashield/logger"
import { withApiRequest } from "@/lib/api-auth"
import { checkMyraRateLimit } from "@/lib/rate-limit"
import {
  myraFail,
  myraNotFound,
  myraOk,
  myraPreflight,
  myraPrincipalEnabled,
  myraRateLimitKey,
  myraRateLimited,
  myraServiceFailure,
} from "../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function get(request: Request): Promise<Response> {
  const resolved = await resolveMyraRequest(request)
  if (!resolved) {
    return myraFail(request, "UNAUTHORIZED", "Authentication required", 401)
  }
  if (!myraPrincipalEnabled(resolved.principal)) return myraNotFound(request)

  const limit = await checkMyraRateLimit("suggest", myraRateLimitKey(resolved.principal))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  try {
    const result = await listOwnCases(resolved)
    return myraOk(request, result)
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra case list failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not load cases", 500)
  }
}

export const GET = withApiRequest(get)
