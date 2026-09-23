/** POST /api/myra/feedback — owner-scoped rating of one assistant answer. */
import { rateAssistantMessage, resolveMyraRequest } from "@lyrashield/myra/server"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
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
} from "../_lib"

export const dynamic = "force-dynamic"

const feedbackSchema = z
  .object({
    messageId: z.string().min(1).max(80),
    rating: z.enum(["helpful", "not_helpful"]),
  })
  .strict()

export function OPTIONS(request: Request): Response {
  return myraPreflight(request)
}

async function post(request: Request): Promise<Response> {
  const resolved = await resolveMyraRequest(request)
  if (!resolved || resolved.principal.kind === "operator") {
    return myraFail(request, "UNAUTHORIZED", "Authentication required", 401)
  }
  if (!myraPrincipalEnabled(resolved.principal)) return myraNotFound(request)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return myraFail(request, "VALIDATION_ERROR", "Invalid request body", 400)
  }
  const parsed = feedbackSchema.safeParse(body)
  if (!parsed.success) return myraFail(request, "VALIDATION_ERROR", "Invalid feedback", 400)
  const limit = await checkMyraRateLimit("message", myraRateLimitKey(resolved.principal))
  if (limit.limited) return myraRateLimited(request, limit.retryAfter)
  try {
    return myraOk(
      request,
      await rateAssistantMessage(resolved, parsed.data.messageId, parsed.data.rating)
    )
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return failure
    logger.error("Myra feedback failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraFail(request, "INTERNAL_ERROR", "Could not save feedback", 500)
  }
}

export const POST = withCookieMutation(post)
