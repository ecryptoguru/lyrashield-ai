/**
 * POST /api/myra/identity/confirm — confirm a verification code.
 *
 * Returns { verified } — the same shape whether the email is unknown, the
 * code is wrong, or attempts ran out (no existence leak either way). Attempt
 * counting/expiry is enforced by the service.
 */
import { confirmIdentityCode, resolveMyraRequest } from "@lyrashield/myra/server"
import { identityConfirmSchema } from "@lyrashield/myra"
import { logger } from "@lyrashield/logger"
import { checkMyraRateLimit, clientIpFromRequest } from "@/lib/rate-limit"
import { withApiRequest } from "@/lib/api-auth"
import {
  myraFail,
  myraNotFound,
  myraOk,
  myraPreflight,
  myraPublicEnabled,
  myraRateLimited,
  myraServiceFailure,
} from "../../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function post(request: Request): Promise<Response> {
  if (!myraPublicEnabled()) return myraNotFound(request)

  // Confirmation attempts are bounded per IP here and per code in the service.
  const limit = await checkMyraRateLimit("verify", clientIpFromRequest(request))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request body", 400)
  }
  const parsed = identityConfirmSchema.safeParse(body)
  if (!parsed.success) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  try {
    const resolved = await resolveMyraRequest(request)
    const principal = resolved?.principal
    if (!principal || principal.kind === "operator") return myraOk(request, { verified: false })
    const verified = await confirmIdentityCode(
      parsed.data.email,
      parsed.data.purpose,
      parsed.data.code,
      principal.kind === "user"
        ? { accountId: principal.accountId }
        : { publicSessionId: principal.publicSessionId }
    )
    return myraOk(request, { verified })
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra identity code confirm failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not verify that code", 500)
  }
}

export const POST = withApiRequest(post)
