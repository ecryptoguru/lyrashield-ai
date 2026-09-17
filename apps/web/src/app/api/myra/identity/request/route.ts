/**
 * POST /api/myra/identity/request — bounded email-verification code for
 * public support-case replies and demo bookings (spec §6).
 *
 * Always answers { ok: true } once Turnstile passes: the response must never
 * reveal whether the address already has cases or bookings. Internal send
 * failures are logged, not surfaced, for the same reason.
 */
import { requestIdentityCode, resolveMyraRequest } from "@lyrashield/myra/server"
import { identityRequestSchema } from "@lyrashield/myra"
import { logger } from "@lyrashield/logger"
import { verifyTurnstile } from "@/lib/turnstile"
import { checkMyraRateLimit, clientIpFromRequest } from "@/lib/rate-limit"
import { withApiRequest } from "@/lib/api-auth"
import {
  myraFail,
  myraNotFound,
  myraOk,
  myraPreflight,
  myraPublicEnabled,
  myraRateLimited,
} from "../../_lib"

export const dynamic = "force-dynamic"

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function post(request: Request): Promise<Response> {
  if (!myraPublicEnabled()) return myraNotFound(request)

  // Bound code sends per IP before the Turnstile call — verification e-mail
  // sends are an abuse vector independent of case existence.
  const limit = await checkMyraRateLimit("verify", clientIpFromRequest(request))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request body", 400)
  }
  // The session binds through the verified public token, never the body — a
  // client-asserted publicSessionId is dropped so older clients keep working.
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    delete (body as Record<string, unknown>).publicSessionId
  }
  const parsed = identityRequestSchema.safeParse(body)
  if (!parsed.success) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  if (!(await verifyTurnstile(parsed.data.turnstileToken))) {
    return myraFail(request, "VERIFICATION_FAILED", "Please retry the abuse check.", 403)
  }

  try {
    const resolved = await resolveMyraRequest(request)
    const principal = resolved?.principal
    if (!principal || principal.kind === "operator")
      throw new Error("MYRA_IDENTITY_CONTEXT_REQUIRED")
    await requestIdentityCode(
      parsed.data.email,
      parsed.data.purpose,
      principal.kind === "user"
        ? { accountId: principal.accountId }
        : { publicSessionId: principal.publicSessionId }
    )
  } catch (error) {
    // Never reveal existence or send failures through this surface — the
    // caller-visible contract is identical either way.
    logger.error("Myra identity code request failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
  }
  return myraOk(request, { ok: true })
}

export const POST = withApiRequest(post)
