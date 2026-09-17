/**
 * POST /api/myra/proposals/confirm — execute a confirmed-write proposal.
 *
 * The confirmation binds the exact payload hash captured at proposal time;
 * the service re-validates ownership (x-myra-session or cookie session) and
 * compares the confirmed payload before executing. MYRA_WRITES_ENABLED gates
 * this whole class of side effects.
 */
import { confirmProposal, resolveMyraRequest } from "@lyrashield/myra/server"
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
  myraWritesEnabled,
} from "../../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function post(request: Request): Promise<Response> {
  const resolved = await resolveMyraRequest(request)
  if (!resolved) {
    return myraFail(request, "UNAUTHORIZED", "Authentication required", 401)
  }
  if (!myraWritesEnabled(resolved.principal)) return myraNotFound(request)
  if (!myraPrincipalEnabled(resolved.principal)) return myraNotFound(request)

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

  const limit = await checkMyraRateLimit("message", myraRateLimitKey(resolved.principal))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  try {
    const result = await confirmProposal(resolved, parsed.data.proposalId)
    return myraOk(request, result)
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra proposal confirm failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not confirm that action", 500)
  }
}

export const POST = withCookieMutation(post)
