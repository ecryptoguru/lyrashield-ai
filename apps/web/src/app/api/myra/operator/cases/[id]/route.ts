/**
 * GET   /api/myra/operator/cases/[id] — operator case detail (12h TOTP read).
 * PATCH /api/myra/operator/cases/[id] — takeover / release / status change.
 *
 * Mutations require the 30-minute TOTP elevation (requirePlatformAdmin) and
 * pass through withCookieMutation so the browser-session origin check applies.
 */
import { requirePlatformAdmin, requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import {
  getOperatorCase,
  operatorRelease,
  operatorSetStatus,
  operatorTakeover,
} from "@lyrashield/myra/server"
import { SUPPORT_CASE_STATUSES } from "@lyrashield/myra"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse, withApiRequest, withCookieMutation } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { myraOperatorEnabled, myraServiceFailure } from "../../../_lib"

export const dynamic = "force-dynamic"

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
}

const patchSchema = z
  .object({
    action: z.enum(["takeover", "release", "resolve", "assign"]),
    status: z.enum(SUPPORT_CASE_STATUSES).optional(),
    assigneeUserId: z.string().max(80).optional(),
  })
  .strict()

function operatorAuthFailure(error: unknown): Response {
  const authError = authErrorResponse(error)
  if (authError) {
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) authError.headers.set(name, value)
    return authError
  }
  return apiError("FORBIDDEN", "Forbidden", 403, PRIVATE_HEADERS)
}

async function get(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!myraOperatorEnabled()) {
    return apiError("NOT_FOUND", "Not found", 404, PRIVATE_HEADERS)
  }
  let operator
  try {
    operator = await requirePlatformAdminIdentity()
  } catch (error) {
    return operatorAuthFailure(error)
  }

  const { id } = await params
  try {
    const result = await getOperatorCase(operator.userId, id)
    const response = apiSuccess(result)
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value)
    return response
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) {
      for (const [name, value] of Object.entries(PRIVATE_HEADERS)) failure.headers.set(name, value)
      return failure
    }
    logger.error("Myra operator case read failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return apiError("INTERNAL_ERROR", "Could not load that case", 500, PRIVATE_HEADERS)
  }
}

async function patch(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!myraOperatorEnabled()) {
    return apiError("NOT_FOUND", "Not found", 404, PRIVATE_HEADERS)
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
    return apiError("VALIDATION_ERROR", "Invalid JSON", 400, PRIVATE_HEADERS)
  }
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "Invalid request", 400, PRIVATE_HEADERS)
  }

  const { id } = await params
  const { action, status, assigneeUserId } = parsed.data
  try {
    let result: unknown
    switch (action) {
      case "takeover":
        // Takeover pauses Myra replies and invalidates unexecuted proposals
        // for that conversation (service-side, spec §6).
        result = await operatorTakeover(operator.userId, id)
        break
      case "release":
        result = await operatorRelease(operator.userId, id)
        break
      case "resolve":
        result = await operatorSetStatus(operator.userId, id, status ?? "RESOLVED")
        break
      case "assign": {
        if (!assigneeUserId) {
          return apiError(
            "VALIDATION_ERROR",
            "assigneeUserId is required for assign",
            400,
            PRIVATE_HEADERS
          )
        }
        // The declared service surface has no dedicated assign function —
        // reject cleanly rather than silently issuing the wrong mutation.
        return apiError(
          "VALIDATION_ERROR",
          "Assign is not supported by the service layer yet",
          400,
          PRIVATE_HEADERS
        )
      }
    }
    const response = apiSuccess(result)
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value)
    return response
  } catch (error) {
    const failure = myraServiceFailure(request, error)
    if (failure) {
      for (const [name, value] of Object.entries(PRIVATE_HEADERS)) failure.headers.set(name, value)
      return failure
    }
    logger.error("Myra operator case mutation failed", {
      error: error instanceof Error ? error.name : "unknown_error",
    })
    return apiError("INTERNAL_ERROR", "Could not update that case", 500, PRIVATE_HEADERS)
  }
}

export const GET = withApiRequest(get)
export const PATCH = withCookieMutation(patch)
