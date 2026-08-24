import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError } from "@/lib/api-response"
import { validatePlatformAdminActionRequest } from "@/lib/platform-admin-request"

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
}

/**
 * Affiliate writes remain closed until each operation uses the one-time
 * elevation nonce and atomic platform audit transaction. Approval also calls
 * an external reserve workflow, so enabling it needs a durable intent/receipt
 * design rather than a partial database wrapper.
 */
export async function POST(request: Request) {
  const boundary = validatePlatformAdminActionRequest(request, { requireElevationNonce: true })
  if (!boundary.ok) return apiError(boundary.code, boundary.message, 403, PRIVATE_HEADERS)

  try {
    await requirePlatformAdminIdentity()
  } catch (error) {
    const authError = authErrorResponse(error)
    if (authError) {
      for (const [name, value] of Object.entries(PRIVATE_HEADERS))
        authError.headers.set(name, value)
      return authError
    }
    return apiError("ADMIN_AUTH_FAILED", "Administrator authorization failed", 403, PRIVATE_HEADERS)
  }

  return apiError(
    "ADMIN_ACTION_DISABLED",
    "Affiliate changes are read-only until atomic platform audit controls are connected",
    503,
    PRIVATE_HEADERS
  )
}
