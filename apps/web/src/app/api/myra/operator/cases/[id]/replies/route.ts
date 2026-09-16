/**
 * POST /api/myra/operator/cases/[id]/replies — operator reply composer.
 *
 * Same boundary as case mutations: allowlisted PLATFORM_OPERATOR browser
 * session, 30-minute TOTP elevation, cookie-session CSRF check.
 */
import { requirePlatformAdmin } from "@lyrashield/auth/server"
import { operatorReply } from "@lyrashield/myra/server"
import { caseReplyRequestSchema } from "@lyrashield/myra"
import { logger } from "@lyrashield/logger"
import { authErrorResponse, withCookieMutation } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { myraOperatorEnabled, myraServiceFailure } from "../../../../_lib"

export const dynamic = "force-dynamic"

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
}

async function post(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!myraOperatorEnabled()) {
    return apiError("NOT_FOUND", "Not found", 404, PRIVATE_HEADERS)
  }

  let operator
  try {
    operator = await requirePlatformAdmin()
  } catch (error) {
    const authError = authErrorResponse(error)
    if (authError) {
      for (const [name, value] of Object.entries(PRIVATE_HEADERS))
        authError.headers.set(name, value)
      return authError
    }
    return apiError("FORBIDDEN", "Forbidden", 403, PRIVATE_HEADERS)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("VALIDATION_ERROR", "Invalid JSON", 400, PRIVATE_HEADERS)
  }
  const parsed = caseReplyRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Invalid request", 400, PRIVATE_HEADERS)
  }

  const { id } = await params
  try {
    const result = await operatorReply(operator.userId, id, parsed.data.body)
    const response = apiSuccess(result)
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value)
    return response
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) {
      for (const [name, value] of Object.entries(PRIVATE_HEADERS)) failure.headers.set(name, value)
      return failure
    }
    logger.error("Myra operator reply failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return apiError("INTERNAL_ERROR", "Could not send that reply", 500, PRIVATE_HEADERS)
  }
}

export const POST = withCookieMutation(post)
