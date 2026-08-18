import { z } from "zod"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { verifyLicense, type LicenseFile } from "@lyrashield/licenses"

export const dynamic = "force-dynamic"

const VerifySchema = z.object({
  licenseFile: z.custom<LicenseFile>(
    (val): val is LicenseFile =>
      typeof val === "object" &&
      val !== null &&
      typeof (val as LicenseFile).sku === "string" &&
      typeof (val as LicenseFile).seatCount === "number" &&
      Array.isArray((val as LicenseFile).machineIds) &&
      typeof (val as LicenseFile).updateEligibleUntil === "string" &&
      typeof (val as LicenseFile).signingKeyId === "string" &&
      typeof (val as LicenseFile).signature === "string" &&
      typeof (val as LicenseFile).issuedAt === "string",
    "licenseFile must be a valid LicenseFile object"
  ),
  // The public key PEM is bundled with the desktop app; the server endpoint
  // accepts it for convenience but the client should verify locally.
  publicKeyPem: z.string().min(1).optional(),
})

/**
 * POST /api/licenses/verify
 *
 * Verify a license file's ed25519 signature and return update-eligibility
 * status. The desktop client should verify locally (offline grace); this
 * endpoint is for server-side checks and client convenience.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    const parsed = VerifySchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { licenseFile, publicKeyPem } = parsed.data

    // The server uses its own bundled public key if the client doesn't supply one.
    // For now we require the client to pass it; a future enhancement will bundle
    // the server's public key as a constant.
    if (!publicKeyPem) {
      return apiError(
        "MISSING_PUBLIC_KEY",
        "publicKeyPem is required for verification",
        400
      )
    }

    const result = verifyLicense(licenseFile, publicKeyPem)

    if (!result.valid) {
      return apiSuccess(
        {
          valid: false,
          updateEligible: false,
          reason: result.reason ?? "verification_failed",
        },
        200
      )
    }

    return apiSuccess(
      {
        valid: true,
        updateEligible: result.updateEligible,
        reason: result.reason,
        sku: licenseFile.sku,
        seatCount: licenseFile.seatCount,
        machineIds: licenseFile.machineIds,
        updateEligibleUntil: licenseFile.updateEligibleUntil,
        perpetualFallbackBuild: licenseFile.perpetualFallbackBuild,
      },
      200
    )
  } catch (error) {
    logger.error("License verification failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to verify license", 500)
  }
}
