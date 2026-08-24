import { z } from "zod"
import { logger } from "@lyrashield/logger"
import { retrieveLicenseByToken } from "@/lib/licenses/license-service"
import { apiError, apiSuccess } from "../../../../lib/api-response"

export const dynamic = "force-dynamic"

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
} as const

const RetrieveSchema = z.object({
  token: z.string().min(10).max(500),
})

/**
 * POST /api/licenses/retrieve
 *
 * One-time retrieval of license key + signed blob via hashed token.
 * Token is looked up by sha256, checked for expiry and single-use (usedAt).
 * Returns generic 404 for any failure (not found / expired / already used)
 * and never logs token or key material.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    const parsed = RetrieveSchema.safeParse(body)
    if (!parsed.success) {
      // Generic 404 to avoid oracle — don't reveal validation details
      return apiError("NOT_FOUND", "License not found", 404, PRIVATE_HEADERS)
    }

    const { token } = parsed.data

    // Also support ?token= query fallback for email link GET convenience
    // but primary is POST body; we ignore query here for POST.

    const result = await retrieveLicenseByToken(token)

    if (!result) {
      return apiError("NOT_FOUND", "License not found", 404, PRIVATE_HEADERS)
    }

    logger.info("License retrieved via one-time token", {
      licenseId: result.licenseId,
    })

    const response = apiSuccess(
      {
        licenseKey: result.licenseKey,
        licenseBlob: result.licenseBlob,
        licenseId: result.licenseId,
      },
      200
    )
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value)
    return response
  } catch (error) {
    logger.error("License retrieval failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    // Generic 404 on unexpected error to avoid leaking token validity
    return apiError("NOT_FOUND", "License not found", 404, PRIVATE_HEADERS)
  }
}
