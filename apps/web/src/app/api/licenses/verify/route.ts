import { z } from "zod"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { verifyLicense, type LicenseFile } from "@lyrashield/licenses"
import { resolveSigningPublicKey } from "../../../../lib/licenses/license-service"
import { checkLicenseApiRateLimit, clientIpFromRequest } from "../../../../lib/rate-limit"

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
})

/**
 * POST /api/licenses/verify
 *
 * Verify a license file's ed25519 signature and return update-eligibility
 * status. The desktop client should verify locally (offline grace); this
 * endpoint is for server-side checks and client convenience.
 *
 * C-08: The server uses its OWN configured public key (derived from
 * LICENSE_SIGNING_PRIVATE_KEY or LICENSE_SIGNING_PUBLIC_KEY) — it NEVER
 * accepts a public key from the client. Accepting a client-supplied key
 * would allow an attacker to forge a license and provide their own key.
 */
export async function POST(request: Request) {
  try {
    // B-M02: Rate limit license verification per IP
    const clientIp = clientIpFromRequest(request)
    const rateLimit = await checkLicenseApiRateLimit(clientIp)
    if (rateLimit.limited) {
      return apiError(
        "RATE_LIMITED",
        "Too many verification requests. Please try again later.",
        429
      )
    }

    const body: unknown = await request.json().catch(() => null)
    const parsed = VerifySchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { licenseFile, licenseKey, licenseId } = parsed.data

    // RISK-B1: revoke is not expiry. Perpetual-fallback never applies to a
    // revoked license. Look the row up by key hash (or id) via the system
    // client — NULL-workspaceId licenses are FORCE-RLS-scoped.
    if (licenseKey || licenseId) {
      const systemPrisma = getSystemPrisma()
      const row = licenseKey
        ? await systemPrisma.licenseKey.findUnique({
            where: { keyHash: hashLicenseKey(licenseKey) },
            include: { license: { select: { id: true, revoked: true } } },
          })
        : await systemPrisma.license.findUnique({
            where: { id: licenseId! },
            select: { id: true, revoked: true },
          })
      const license = licenseKey
        ? (row as { license?: { id: string; revoked: boolean } } | null)?.license
        : (row as { id: string; revoked: boolean } | null)
      if (license?.revoked) {
        return apiSuccess(
          {
            valid: false,
            updateEligible: false,
            revoked: true,
            reason: "LICENSE_REVOKED",
          },
          200
        )
      }
    }

    // C-08: Always use the server's own public key — never trust a key
    // supplied by the client. An attacker could forge a license and provide
    // their own public key to make verification pass.
    const serverPublicKeyPem = resolveSigningPublicKey()

    const result = verifyLicense(licenseFile, serverPublicKeyPem)

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

    // B-L06: Don't echo full payload to unauthenticated callers.
    // Return only the essential fields needed for client decisions.
    return apiSuccess(
      {
        valid: true,
        revoked: false,
        updateEligible: result.updateEligible,
        reason: result.reason,
        // Include SKU and expiry for client-side update prompts, but not
        // the full machineIds list or perpetualFallbackBuild.
        sku: licenseFile.sku,
        updateEligibleUntil: licenseFile.updateEligibleUntil,
      },
      200
    )
  } catch (error) {
    logger.error("License verification failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to verify license", 500)
  }
}
