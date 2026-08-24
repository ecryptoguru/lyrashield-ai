import { z } from "zod"
import {
  auth,
  requirePlatformAdmin,
  requirePlatformAdminCandidateIdentity,
} from "@lyrashield/auth/server"
import { issuePlatformAdminElevation } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { validatePlatformAdminActionRequest } from "@/lib/platform-admin-request"

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
}

const ElevationSchema = z.object({
  action: z.enum([
    "affiliate.approve",
    "affiliate.reject",
    "affiliate.suspend",
    "affiliate.reconcile-payout",
    "affiliate.verify-payout-profile",
    "affiliate.tier-override",
  ]),
  code: z.string().regex(/^\d{6}$/),
})

export async function POST(request: Request) {
  const boundary = validatePlatformAdminActionRequest(request)
  if (!boundary.ok) {
    return apiError(boundary.code, boundary.message, 403, PRIVATE_HEADERS)
  }

  try {
    const identity = await requirePlatformAdminCandidateIdentity()
    const parsed = ElevationSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return apiError("INVALID_REQUEST", "Invalid request", 400, PRIVATE_HEADERS)

    await auth.api.verifyTOTP({
      body: { code: parsed.data.code, trustDevice: false },
      headers: request.headers,
    })
    const elevated = await requirePlatformAdmin({ maxElevationAgeMs: 60_000 })
    if (elevated.userId !== identity.userId || elevated.sessionId !== identity.sessionId) {
      return apiError(
        "ADMIN_SESSION_CHANGED",
        "Administrator session changed",
        409,
        PRIVATE_HEADERS
      )
    }

    const authorization = await issuePlatformAdminElevation({
      userId: elevated.userId,
      sessionId: elevated.sessionId,
      action: parsed.data.action,
    })
    const response = apiSuccess(
      {
        action: parsed.data.action,
        nonce: authorization.nonce,
        expiresAt: authorization.expiresAt,
      },
      201
    )
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value)
    return response
  } catch (error) {
    const authError = authErrorResponse(error)
    if (authError) {
      for (const [name, value] of Object.entries(PRIVATE_HEADERS))
        authError.headers.set(name, value)
      return authError
    }
    logger.warn("Platform administrator elevation denied", {
      reason: error instanceof Error ? error.message : "unknown",
    })
    return apiError(
      "ADMIN_ELEVATION_DENIED",
      "Administrator verification failed",
      403,
      PRIVATE_HEADERS
    )
  }
}
