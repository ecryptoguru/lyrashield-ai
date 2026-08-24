import { requirePlatformAdminIdentity } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { getPlatformAdminOverview } from "@/lib/platform-admin-overview"

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
}

export async function GET() {
  try {
    await requirePlatformAdminIdentity()
    const response = apiSuccess(await getPlatformAdminOverview())
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value)
    return response
  } catch (error) {
    const authError = authErrorResponse(error)
    if (authError) {
      for (const [name, value] of Object.entries(PRIVATE_HEADERS))
        authError.headers.set(name, value)
      return authError
    }
    logger.error("Failed to load platform admin overview")
    return apiError("INTERNAL_ERROR", "Failed to load platform status", 500, PRIVATE_HEADERS)
  }
}
