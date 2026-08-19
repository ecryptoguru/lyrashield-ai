import { z } from "zod"
import { getSystemPrisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { verifyLicense, type LicenseFile } from "@lyrashield/licenses"
import { hashLicenseKey, resolveSigningPublicKey } from "../../../../lib/licenses/license-service"
import { checkLicenseApiRateLimit, clientIpFromRequest } from "../../../../lib/rate-limit"

export const dynamic = "force-dynamic"

const VerifySchema = z.object({
  /** Preferred: raw license key. Server looks up revoked against the DB row. */
  licenseKey: z.string().min(1).max(200).optional(),
  /** Fallback identity when the client only has the cached license id. */
  licenseId: z.string().min(1).max(200).optional(),
  licenseFile: z
    .custom<LicenseFile>(
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
    )
    .optional(),
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
 *
 * RISK-B1: revoke is not expiry. If licenseKey or licenseId is supplied,
 * the DB row is checked via getSystemPrisma. A revoked license never
 * rides perpetual-fallback.
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

    if (!licenseFile && !licenseKey && !licenseId) {
      return apiError("VALIDATION_ERROR", "licenseFile, licenseKey, or licenseId is required", 400)
    }

    // RISK-B1: revoke is not expiry. Perpetual-fallback never applies to a
    // revoked license. Look the row up by key hash (or id) via the system
    // client — NULL-workspaceId licenses are FORCE-RLS-scoped.
    if (licenseKey || licenseId) {
      const systemPrisma = getSystemPrisma()
      let revoked = false
      if (licenseKey) {
        const keyRow = await systemPrisma.licenseKey.findUnique({
          where: { keyHash: hashLicenseKey(licenseKey) },
          include: { license: { select: { id: true, revoked: true } } },
        })
        revoked = keyRow?.license.revoked === true
      } else if (licenseId) {
        const licenseRow = await systemPrisma.license.findUnique({
          where: { id: licenseId },
          select: { id: true, revoked: true },
        })
        revoked = licenseRow?.revoked === true
      }
      if (revoked) {
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

    // Desktop revalidate only sends licenseId. After the revoke check above,
    // there is nothing left to cryptographically verify without a licenseFile.
    if (!licenseFile) {
      return apiSuccess(
        {
          valid: true,
          revoked: false,
          updateEligible: false,
          reason: "identity_ok",
        },
        200
      )
    }

    // C-08: Always use the server's own public key — never trust a key
    // supplied by the client. An attacker could forge a license and provide
    // their own public key to make verification pass.
    const serverPublicKeyPem = await resolveSigningPublicKey()

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
