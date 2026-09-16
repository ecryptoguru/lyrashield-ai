/**
 * POST /api/myra/proposals/cancel — abandon a pending proposal.
 *
 * Cancellation is not itself a confirmed write (it executes nothing), so it
 * is not gated by MYRA_WRITES_ENABLED — but cookie sessions still pass the
 * same-origin mutation check via withCookieMutation, and public-session
 * ownership is enforced by the service against x-myra-session.
 */
import { cancelProposal, resolveMyraRequest } from "@lyrashield/myra/server"
import { confirmProposalRequestSchema } from "@lyrashield/myra"
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
} from "../../_lib"

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
  const parsed = confirmProposalRequestSchema.safeParse(body)
  if (!parsed.success) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  const resolved = await resolveMyraRequest(request)
  if (!resolved) {
    return myraFail(request, "UNAUTHORIZED", "Authentication required", 401)
  }
  if (!myraPrincipalEnabled(resolved.principal)) return myraNotFound(request)

  const limit = await checkMyraRateLimit("message", myraRateLimitKey(resolved.principal))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  try {
    const result = await cancelProposal(resolved, parsed.data.proposalId)
    return myraOk(request, result)
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra proposal cancel failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not cancel that action", 500)
  }
}

export const POST = withCookieMutation(post)
