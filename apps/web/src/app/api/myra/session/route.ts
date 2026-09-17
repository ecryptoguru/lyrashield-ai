/**
 * POST /api/myra/session — resolve or mint a Myra session.
 *
 * A request carrying a valid browser cookie session resolves to
 * `{ principal: "user" }` and gets no public token (the cookie is the
 * credential). Anything else mints an anonymous public session behind a
 * Turnstile check; the client stores the returned token and sends it back as
 * `x-myra-session` on every later call.
 */
import { issuePublicSession, resolveMyraRequest } from "@lyrashield/myra/server"
import { myraSurfaceSchema } from "@lyrashield/myra"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { verifyTurnstile } from "@/lib/turnstile"
import { checkMyraRateLimit, clientIpFromRequest } from "@/lib/rate-limit"
import { withApiRequest } from "@/lib/api-auth"
import {
  myraFail,
  myraNotFound,
  myraOk,
  myraPreflight,
  myraPrincipalEnabled,
  myraPublicEnabled,
  myraRateLimited,
} from "../_lib"

export const dynamic = "force-dynamic"

const sessionRequestSchema = z
  .object({
    surface: myraSurfaceSchema,
    turnstileToken: z.string().trim().max(4096).optional(),
  })
  .strict()

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function post(request: Request): Promise<Response> {
  const resolved = await resolveMyraRequest(request)

  // Existing browser session — the cookie is the credential.
  if (resolved?.principal.kind === "user") {
    if (!myraPrincipalEnabled(resolved.principal)) return myraNotFound(request)
    return myraOk(request, { principal: "user" })
  }

  if (!myraPublicEnabled()) return myraNotFound(request)

  // Still-valid public session: no new token; the client keeps the one it has.
  if (resolved?.principal.kind === "anonymous") {
    return myraOk(request, { principal: "anonymous" })
  }

  // Public-session mints are a credential-issuing surface: bound them per IP
  // before spending a Turnstile verification call.
  const limit = await checkMyraRateLimit("verify", clientIpFromRequest(request))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request body", 400)
  }
  const parsed = sessionRequestSchema.safeParse(body)
  if (!parsed.success) {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request", 400)
  }

  // Turnstile is required for anonymous issue (spec §5 abuse controls).
  if (!(await verifyTurnstile(parsed.data.turnstileToken))) {
    return myraFail(request, "VERIFICATION_FAILED", "Please retry the abuse check.", 403)
  }

  try {
    const issued = await issuePublicSession(parsed.data.surface)
    return myraOk(request, {
      principal: "anonymous",
      publicToken: issued.token,
      sessionId: issued.publicSessionId,
    })
  } catch (error) {
    logger.error("Myra public session issue failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not start a session", 500)
  }
}

export const POST = withApiRequest(post)
