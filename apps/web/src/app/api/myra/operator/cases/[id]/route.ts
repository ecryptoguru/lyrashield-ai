/**
 * GET   /api/myra/operator/cases/[id] — operator case detail (12h TOTP read).
 * PATCH /api/myra/operator/cases/[id] — takeover / release / status change.
 *
 * Mutations require the 30-minute TOTP elevation (requirePlatformAdmin) plus
 * an action-specific single-use elevation nonce that executePlatformAdminMutation
 * consumes atomically with the platform audit row — the same boundary the
 * affiliate admin actions use. Requests pass through withCookieMutation so the
 * browser-session origin check applies.
 */
import { requirePlatformAdmin, requirePlatformAdminIdentity } from "@lyrashield/auth/server"

import {
  getOperatorCase,
  operatorAssign,
  operatorRelease,
  operatorSetStatus,
  operatorTakeover,
} from "@lyrashield/myra/server"
import { SUPPORT_CASE_STATUSES } from "@lyrashield/myra"
import { executePlatformAdminMutation, withMyraOperatorRLS } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse, withApiRequest, withCookieMutation } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { validatePlatformAdminActionRequest } from "@/lib/platform-admin-request"
import { clientIpFromRequest } from "@/lib/rate-limit"
import { myraOperatorEnabled, myraOperatorPrivate, myraServiceFailure } from "../../../_lib"

export const dynamic = "force-dynamic"

const patchSchema = z
  .object({
    action: z.enum(["takeover", "release", "resolve", "assign"]),
    status: z.enum(SUPPORT_CASE_STATUSES).optional(),
    handoffSummary: z.string().trim().min(10).max(4000).optional(),
  })
  .strict()

function operatorAuthFailure(error: unknown): Response {
  const authError = authErrorResponse(error)
  if (authError) return myraOperatorPrivate(authError)
  return myraOperatorPrivate(apiError("FORBIDDEN", "Forbidden", 403))
}

async function get(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!myraOperatorEnabled()) {
    return myraOperatorPrivate(apiError("NOT_FOUND", "Not found", 404))
  }
  let operator
  try {
    operator = await requirePlatformAdminIdentity()
  } catch (error) {
    return operatorAuthFailure(error)
  }

  const { id } = await params
  try {
    const result = await withMyraOperatorRLS(operator.userId, (tx) =>
      getOperatorCase(operator.userId, id, tx)
    )
    return myraOperatorPrivate(apiSuccess(result))
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) return myraOperatorPrivate(failure)
    logger.error("Myra operator case read failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraOperatorPrivate(apiError("INTERNAL_ERROR", "Could not load that case", 500))
  }
}

async function patch(
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
    // Mutations require the short 30-minute TOTP elevation window.
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
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return myraOperatorPrivate(apiError("VALIDATION_ERROR", "Invalid request", 400))
  }

  const { id } = await params
  const { action, status, handoffSummary } = parsed.data
  if (action === "release" && !handoffSummary) {
    return myraOperatorPrivate(
      apiError("VALIDATION_ERROR", "A reviewed handoff summary is required", 400)
    )
  }
  const ipAddress = clientIpFromRequest(request)
  try {
    const result = await executePlatformAdminMutation(
      {
        userId: operator.userId,
        sessionId: operator.sessionId,
        action: `myra.case.${action}`,
        nonce: elevationNonce,
        resourceType: "SupportCase",
        resourceId: id,
        ipAddress: ipAddress === "unknown" ? undefined : ipAddress,
        userAgent: request.headers.get("user-agent")?.slice(0, 512),
        metadata: status ? { status } : undefined,
      },
      () =>
        // Operator-bound trusted path: requirePlatformAdmin above is the
        // authorization, the binding declares it to the dual-owner tables'
        // RESTRICTIVE boundary (v18 1.3). The service runs on its own bound
        // transaction because the boundary only reads the tx-local settings
        // this binding sets.
        withMyraOperatorRLS(operator.userId, async (tx) => {
          switch (action) {
            case "takeover":
              // Takeover pauses Myra replies and invalidates unexecuted
              // proposals for that conversation (service-side, spec §6).
              return operatorTakeover(operator.userId, id, tx)
            case "release":
              return operatorRelease(operator.userId, id, handoffSummary!, tx)
            case "resolve":
              return operatorSetStatus(operator.userId, id, status ?? "RESOLVED", tx)
            case "assign":
              return operatorAssign(operator.userId, id, tx)
          }
        })
    )
    return myraOperatorPrivate(apiSuccess(result))
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
    logger.error("Myra operator case mutation failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return myraOperatorPrivate(apiError("INTERNAL_ERROR", "Could not update that case", 500))
  }
}

export const GET = withApiRequest(get)
export const PATCH = withCookieMutation(patch)
