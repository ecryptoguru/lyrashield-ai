/**
 * GET /api/myra/cases/[id] — read one own support case with replies.
 * A foreign or fabricated id resolves to NOT_FOUND from the service — never
 * another principal's case.
 */
import { getOwnCase, resolveMyraRequest } from "@lyrashield/myra/server"
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
} from "../../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function get(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params
  const resolved = await resolveMyraRequest(request)
  if (!resolved) {
    return myraFail(request, "UNAUTHORIZED", "Authentication required", 401)
  }
  if (!myraPrincipalEnabled(resolved.principal)) return myraNotFound(request)

  const limit = await checkMyraRateLimit("suggest", myraRateLimitKey(resolved.principal))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  try {
    const result = await getOwnCase(resolved, id)
    return myraOk(request, result)
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra case read failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not load that case", 500)
  }
}

export const GET = withApiRequest(get)
