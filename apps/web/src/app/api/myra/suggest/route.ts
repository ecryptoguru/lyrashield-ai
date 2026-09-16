/**
 * POST /api/myra/suggest — type-ahead instant suggestions.
 *
 * Retrieval only: the service searches approved public knowledge entries and
 * never makes a model call (spec §13.3). Public-allowed with a resolved
 * session so anonymous callers never receive restricted entries.
 */
import { resolveMyraRequest, suggest } from "@lyrashield/myra/server"
import { suggestRequestSchema } from "@lyrashield/myra"
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
  myraSurfaceEnabled,
} from "../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function post(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request body", 400)
  }
  const parsed = suggestRequestSchema.safeParse(body)
  if (!parsed.success) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  if (!myraSurfaceEnabled(parsed.data.surface)) return myraNotFound(request)

  const resolved = await resolveMyraRequest(request)
  if (!resolved) {
    return myraFail(
      request,
      "UNAUTHORIZED",
      "Start a Myra session before asking for suggestions",
      401
    )
  }
  if (!myraPrincipalEnabled(resolved.principal)) return myraNotFound(request)

  const limit = await checkMyraRateLimit("suggest", myraRateLimitKey(resolved.principal))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  try {
    const result = await suggest(
      resolved,
      parsed.data.text,
      parsed.data.surface,
      parsed.data.routeContext
    )
    return myraOk(request, result)
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra suggest failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not load suggestions", 500)
  }
}

export const POST = withApiRequest(post)
