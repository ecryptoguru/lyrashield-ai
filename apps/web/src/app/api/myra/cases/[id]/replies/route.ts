/**
 * POST /api/myra/cases/[id]/replies — user-authored case reply.
 *
 * Per spec §5, the user clicking Send IS the confirmation for their own exact
 * message — no redundant proposal round-trip. It is still a write, so it sits
 * behind MYRA_WRITES_ENABLED and the cookie-session CSRF check.
 */
import { replyToOwnCase, resolveMyraRequest } from "@lyrashield/myra/server"
import { caseReplyRequestSchema } from "@lyrashield/myra"
import { logger } from "@lyrashield/logger"
import { withCookieMutation } from "@/lib/api-auth"
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
  myraWritesEnabled,
} from "../../../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function post(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const resolved = await resolveMyraRequest(request)
  if (!resolved) {
    return myraFail(request, "UNAUTHORIZED", "Authentication required", 401)
  }
  if (!myraWritesEnabled(resolved.principal)) return myraNotFound(request)
  if (!myraPrincipalEnabled(resolved.principal)) return myraNotFound(request)

  const { id } = await params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request body", 400)
  }
  const parsed = caseReplyRequestSchema.safeParse(body)
  if (!parsed.success) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  const limit = await checkMyraRateLimit("message", myraRateLimitKey(resolved.principal))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  try {
    const result = await replyToOwnCase(resolved, id, parsed.data.body)
    return myraOk(request, result)
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra case reply failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not send that reply", 500)
  }
}

export const POST = withCookieMutation(post)
