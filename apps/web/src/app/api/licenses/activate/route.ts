import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import {
  hashLicenseKey,
  issueSignedLicense,
  machineCapForSku,
  isIndividualSku,
} from "../../../../lib/licenses/license-service"
import type { LocalSkuId } from "@lyrashield/pricing"

export const dynamic = "force-dynamic"

const ActivateSchema = z.object({
  licenseKey: z.string().min(1).max(200),
  machineId: z.string().min(1).max(200),
})

/**
 * POST /api/licenses/activate
 *
 * Activate a machine against a Local license. Validates the license key hash
 * against the `LicenseKey` table, checks the seat/machine cap (Individual: 3
 * machines, Team: per-seat), and issues a signed license file (ed25519).
 *
 * Idempotent on (licenseId, machineId): re-activating the same machine just
 * refreshes `lastSeenAt` and re-issues the license file.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    const parsed = ActivateSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { licenseKey, machineId } = parsed.data

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

    const sku = license.sku as LocalSkuId
    const cap = machineCapForSku(sku, license.seatCount)

    // Check if this machine is already activated (idempotent path).
    const existing = await prisma.licenseActivation.findUnique({
      where: { licenseId_machineId: { licenseId: license.id, machineId } },
    })

    if (!existing) {
      // New activation — enforce machine cap.
      // Count active (non-deactivated) activations.
      const activeCount = await prisma.licenseActivation.count({
        where: { licenseId: license.id, deactivatedAt: null },
      })

      if (activeCount >= cap) {
        return apiError(
          "MACHINE_CAP_REACHED",
          isIndividualSku(sku)
            ? `Individual licenses allow up to ${cap} machines. Deactivate a machine or upgrade to a team license.`
            : `This team license has ${license.seatCount} seat(s) and all are in use.`,
          409
        )
      }

      await prisma.licenseActivation.create({
        data: {
          licenseId: license.id,
          workspaceId: license.workspaceId,
          machineId,
          lastSeenAt: new Date(),
        },
      })
    } else {
      // Refresh lastSeenAt for the existing activation.
      await prisma.licenseActivation.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date(), deactivatedAt: null },
      })
    }

    // Update machineIds on the License row and issue the signed license file.
    const allActivations = await prisma.licenseActivation.findMany({
      where: { licenseId: license.id, deactivatedAt: null },
      select: { machineId: true },
    })
    const machineIds = allActivations.map((a) => a.machineId)

    await prisma.license.update({
      where: { id: license.id },
      data: { machineIds },
    })

    const licenseFile = await issueSignedLicense(license.id, license.perpetualFallbackBuild)

    logger.info("License activated", {
      licenseId: license.id,
      machineId,
      machineCount: machineIds.length,
      sku,
    })

    return apiSuccess({ license: licenseFile }, 200)
  } catch (error) {
    logger.error("License activation failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to activate license", 500)
  }
}
