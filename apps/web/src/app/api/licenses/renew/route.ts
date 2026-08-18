import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { getLocalSku, type LocalSkuId } from "@lyrashield/pricing"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import {
  hashLicenseKey,
  issueSignedLicense,
  computeUpdateEligibleUntil,
} from "../../../../lib/licenses/license-service"

export const dynamic = "force-dynamic"

const RenewSchema = z.object({
  licenseKey: z.string().min(1).max(200),
  renewalSku: z.enum([
    "renewal",
    "individual_launch",
    "individual_regular",
    "team_perpetual",
    "team_subscription",
  ]),
})

/**
 * POST /api/licenses/renew
 *
 * Extend `updateEligibleUntil` by 1 year (365 days) and re-issue a signed
 * license file. The `renewalSku` must be a valid renewal or original SKU.
 *
 * In production this is triggered by a Polar `order.paid` webhook for the
 * renewal SKU; it is also exposed as a direct API for manual renewals.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    const parsed = RenewSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { licenseKey, renewalSku } = parsed.data

    const keyHash = hashLicenseKey(licenseKey)
    const licenseKeyRow = await prisma.licenseKey.findUnique({
      where: { keyHash },
      include: { license: true },
    })

    if (!licenseKeyRow) {
      return apiError("LICENSE_KEY_NOT_FOUND", "The provided license key is not recognized", 404)
    }

    const license = licenseKeyRow.license
    if (license.revoked) {
      return apiError("LICENSE_REVOKED", "This license has been revoked", 403)
    }

    // Validate the renewal SKU is a legitimate renewal product.
    const skuDef = getLocalSku(renewalSku as LocalSkuId)
    if (!skuDef || !skuDef.includesUpdates) {
      return apiError("INVALID_RENEWAL_SKU", "The renewal SKU does not include updates", 400)
    }

    // Extend update eligibility by 365 days from the current expiry (or from
    // now if already expired — we don't penalize late renewals by starting
    // the clock from today).
    const currentExpiry = license.updateEligibleUntil
    const baseDate = currentExpiry > new Date() ? currentExpiry : new Date()
    const newExpiry = computeUpdateEligibleUntil(renewalSku as LocalSkuId, baseDate)

    await prisma.license.update({
      where: { id: license.id },
      data: { updateEligibleUntil: newExpiry },
    })

    const licenseFile = await issueSignedLicense(license.id, license.perpetualFallbackBuild)

    logger.info("License renewed", {
      licenseId: license.id,
      renewalSku,
      newExpiry: newExpiry.toISOString(),
    })

    return apiSuccess(
      {
        license: licenseFile,
        updateEligibleUntil: newExpiry.toISOString(),
      },
      200
    )
  } catch (error) {
    logger.error("License renewal failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to renew license", 500)
  }
}
