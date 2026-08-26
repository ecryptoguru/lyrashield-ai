import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError } from "../../../../lib/api-response"
import { validatePlatformAdminActionRequest } from "../../../../lib/platform-admin-request"

export const dynamic = "force-dynamic"

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
}

/**
 * POST /api/licenses/revoke
 *
 * License revocation remains closed until it is connected to an action-specific
 * elevation and the atomic platform-audit mutation primitive.
 */
export async function POST(request: Request) {
  try {
    await requirePlatformAdminIdentity()
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) {
      for (const [name, value] of Object.entries(PRIVATE_HEADERS)) authErr.headers.set(name, value)
      return authErr
    }
    return apiError("ADMIN_AUTH_FAILED", "Administrator authorization failed", 403, PRIVATE_HEADERS)
  }

  // No elevation can authorize this action yet. Authenticate and enforce the
  // browser boundary, then return the explicit disabled response below.
  const boundary = validatePlatformAdminActionRequest(request)
  if (!boundary.ok) return apiError(boundary.code, boundary.message, 403, PRIVATE_HEADERS)

  return apiError(
    "ADMIN_ACTION_DISABLED",
    "License revocation is disabled until atomic platform audit controls are connected",
    503,
    PRIVATE_HEADERS
  )
}
