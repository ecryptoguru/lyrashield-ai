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
import { myraOperatorEnabled, myraOperatorPrivate, myraServiceFailure } from "../../../../_lib"

export const dynamic = "force-dynamic"

async function post(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!myraOperatorEnabled()) {
    return myraOperatorPrivate(apiError("NOT_FOUND", "Not found", 404))
  }

  let operator
  try {
    operator = await requirePlatformAdmin()
  } catch (error) {
    const authError = authErrorResponse(error)
    if (authError) return myraOperatorPrivate(authError)
    return myraOperatorPrivate(apiError("FORBIDDEN", "Forbidden", 403))
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return myraOperatorPrivate(apiError("VALIDATION_ERROR", "Invalid JSON", 400))
  }
  const parsed = caseReplyRequestSchema.safeParse(body)
  if (!parsed.success) {
    return myraOperatorPrivate(apiError("VALIDATION_ERROR", "Invalid request", 400))
  }

  const { id } = await params
  try {
    const result = await operatorReply(operator.userId, id, parsed.data.body)
    return myraOperatorPrivate(apiSuccess(result))
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return myraOperatorPrivate(failure)
    logger.error("Myra operator reply failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraOperatorPrivate(apiError("INTERNAL_ERROR", "Could not send that reply", 500))
  }
}

export const POST = withCookieMutation(post)
