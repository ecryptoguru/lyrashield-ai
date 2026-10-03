import { requirePlatformAdmin } from "@lyrashield/auth/server"
import { authErrorResponse, withCookieMutation } from "@/lib/api-auth"
import { apiError } from "@/lib/api-response"
import { validatePlatformAdminActionRequest } from "@/lib/platform-admin-request"
import { clientIpFromRequest } from "@/lib/rate-limit"
import { disposeWebhookTrack, dispositionSchema, PRIVATE_HEADERS } from "./disposition-handler"

export const dynamic = "force-dynamic"

async function post(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const boundary = validatePlatformAdminActionRequest(request, { requireElevationNonce: true })
  if (!boundary.ok || !boundary.elevationNonce) {
    return apiError(
      boundary.ok ? "ADMIN_ELEVATION_REQUIRED" : boundary.code,
      boundary.ok ? "A valid administrator elevation is required" : boundary.message,
      403,
      PRIVATE_HEADERS
    )
  }

  let admin
  try {
    admin = await requirePlatformAdmin()
  } catch (error) {
    const authError = authErrorResponse(error)
    return privateResponse(authError ?? apiError("FORBIDDEN", "Forbidden", 403, PRIVATE_HEADERS))
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("VALIDATION_ERROR", "Invalid JSON", 400, PRIVATE_HEADERS)
  }
  const parsed = dispositionSchema.safeParse(body)
  if (!parsed.success) return apiError("VALIDATION_ERROR", "Invalid request", 400, PRIVATE_HEADERS)

  const { id } = await params
  if (!id || id.length > 191 || id.trim() !== id) {
    return apiError("VALIDATION_ERROR", "Invalid track id", 400, PRIVATE_HEADERS)
  }

  const ip = clientIpFromRequest(request)
  return disposeWebhookTrack({
    id,
    admin,
    nonce: boundary.elevationNonce,
    expectedGeneration: parsed.data.expectedGeneration,
    reason: parsed.data.reason,
    evidenceReference: parsed.data.evidenceReference,
    ipAddress: ip === "unknown" ? undefined : ip,
    userAgent: request.headers.get("user-agent")?.trim().slice(0, 512) || undefined,
  })
}

function privateResponse(response: Response): Response {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value)
  return response
}

export const POST = withCookieMutation(post)
