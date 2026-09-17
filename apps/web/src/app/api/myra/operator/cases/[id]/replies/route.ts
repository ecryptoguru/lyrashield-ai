/**
 * POST /api/myra/operator/cases/[id]/replies — operator reply (30-minute TOTP
 * elevation + an action-specific single-use elevation nonce). The nonce is
 * consumed atomically with the platform audit row by
 * executePlatformAdminMutation — the same boundary the affiliate admin
 * actions use. The request passes through withCookieMutation so the
 * browser-session origin check applies.
 */
import { requirePlatformAdmin } from "@lyrashield/auth/server"

import { operatorReply } from "@lyrashield/myra/server"
import { caseReplyRequestSchema } from "@lyrashield/myra"
import { bindMyraOperatorRLSContext, executePlatformAdminMutation } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { authErrorResponse, withCookieMutation } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { validatePlatformAdminActionRequest } from "@/lib/platform-admin-request"
import { clientIpFromRequest } from "@/lib/rate-limit"
import { myraOperatorEnabled, myraOperatorPrivate, myraServiceFailure } from "../../../../_lib"

function operatorAuthFailure(error: unknown): Response {
  const response = authErrorResponse(error)
  return myraOperatorPrivate(
    response ?? apiError("FORBIDDEN", "A platform operator session is required", 403)
  )
}

async function post(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!myraOperatorEnabled()) {
    return myraOperatorPrivate(apiError("NOT_FOUND", "Not found", 404))
  }

  // Same request boundary as the other platform-admin mutations: same-origin
  // JSON carrying a well-formed action-specific elevation nonce.
  const boundary = validatePlatformAdminActionRequest(request, { requireElevationNonce: true })
  if (!boundary.ok) {
    return myraOperatorPrivate(apiError(boundary.code, boundary.message, 403))
  }
  const elevationNonce = boundary.elevationNonce
  if (!elevationNonce) {
    return myraOperatorPrivate(
      apiError("ADMIN_ELEVATION_REQUIRED", "A valid administrator elevation is required", 403)
    )
  }

  let operator
  try {
    operator = await requirePlatformAdmin()
  } catch (error) {
    return operatorAuthFailure(error)
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
  const ipAddress = clientIpFromRequest(request)
  try {
    const reply = await executePlatformAdminMutation(
      {
        userId: operator.userId,
        sessionId: operator.sessionId,
        action: "myra.case.reply",
        nonce: elevationNonce,
        resourceType: "SupportCase",
        resourceId: id,
        ipAddress: ipAddress === "unknown" ? undefined : ipAddress,
        userAgent: request.headers.get("user-agent")?.slice(0, 512),
      },
      async (tx) => {
        await bindMyraOperatorRLSContext(tx, operator.userId)
        return operatorReply(operator.userId, id, parsed.data.body, tx)
      }
    )
    return myraOperatorPrivate(apiSuccess(reply))
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_ELEVATION_INVALID") {
      return myraOperatorPrivate(
        apiError(
          "ADMIN_ELEVATION_INVALID",
          "That elevation expired or was already used — authorize the action again",
          409
        )
      )
    }
    if (error instanceof Error && error.message === "ADMIN_AUTHORITY_REVOKED") {
      return myraOperatorPrivate(apiError("FORBIDDEN", "Forbidden", 403))
    }
    const failure = myraServiceFailure(request, error)
    if (failure) return myraOperatorPrivate(failure)
    logger.error("Myra operator reply failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraOperatorPrivate(apiError("INTERNAL_ERROR", "Could not send that reply", 500))
  }
}

export const POST = withCookieMutation(post)
