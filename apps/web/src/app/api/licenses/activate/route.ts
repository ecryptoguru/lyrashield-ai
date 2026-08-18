import { z } from "zod"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import {
  hashLicenseKey,
  issueSignedLicense,
  machineCapForSku,
} from "../../../../lib/licenses/license-service"
import { checkLicenseApiRateLimit, clientIpFromRequest } from "../../../../lib/rate-limit"
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
 *
 * C-03: The cap check + activation create are wrapped in a transaction with a
 * `SELECT FOR UPDATE` lock on the License row to prevent a race condition
 * where two concurrent requests both pass the cap check and exceed the limit.
 */
export async function POST(request: Request) {
  try {
    // B-M02: Rate limit license activation per IP
    const clientIp = clientIpFromRequest(request)
    const rateLimit = await checkLicenseApiRateLimit(clientIp)
    if (rateLimit.limited) {
      return apiError("RATE_LIMITED", "Too many activation requests. Please try again later.", 429)
    }

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

    // C-03: Wrap the cap check + activation in a transaction with a row lock
    // to prevent concurrent requests from both passing the cap check.
    const result = await prisma.$transaction(async (tx) => {
      // Lock the License row so concurrent activations for the same license
      // are serialized. This prevents the TOCTOU race between counting active
      // activations and creating a new one.
      await tx.$queryRaw`SELECT * FROM "License" WHERE id = ${license.id} FOR UPDATE`

      // Check if this machine is already activated (idempotent path).
      const existing = await tx.licenseActivation.findUnique({
        where: { licenseId_machineId: { licenseId: license.id, machineId } },
      })

      if (!existing) {
        // New activation — enforce machine cap.
        const activeCount = await tx.licenseActivation.count({
          where: { licenseId: license.id, deactivatedAt: null },
        })

        if (activeCount >= cap) {
          return { capped: true as const, machineIds: [] as string[] }
        }

        await tx.licenseActivation.create({
          data: {
            licenseId: license.id,
            workspaceId: license.workspaceId,
            machineId,
            lastSeenAt: new Date(),
          },
        })
      } else {
        // Refresh lastSeenAt for the existing activation.
        await tx.licenseActivation.update({
          where: { id: existing.id },
          data: { lastSeenAt: new Date(), deactivatedAt: null },
        })
      }

      // Update machineIds on the License row within the same transaction.
      const allActivations = await tx.licenseActivation.findMany({
        where: { licenseId: license.id, deactivatedAt: null },
        select: { machineId: true },
      })
      const machineIds = allActivations.map((a) => a.machineId)

      await tx.license.update({
        where: { id: license.id },
        data: { machineIds },
      })

      return { capped: false as const, machineIds }
    })

    if (result.capped) {
      // B-M07: Generic error message — don't leak seat count
      return apiError(
        "MACHINE_CAP_REACHED",
        "Machine cap reached. Deactivate a machine or upgrade your license.",
        409
      )
    }

    // Issue the signed license file outside the transaction — it does its own
    // DB reads/writes and the machineIds are already committed.
    const licenseFile = await issueSignedLicense(license.id, license.perpetualFallbackBuild)

    logger.info("License activated", {
      licenseId: license.id,
      machineId,
      machineCount: result.machineIds.length,
      sku,
    })

    // B-L01: Audit log the activation
    await prisma.auditLog.create({
      data: {
        workspaceId: license.workspaceId ?? license.id,
        action: "license.activated",
        resourceType: "license",
        resourceId: license.id,
        metadata: { machineId, machineCount: result.machineIds.length, sku },
      },
    }).catch(() => {})

    return apiSuccess({ license: licenseFile }, 200)
  } catch (error) {
    logger.error("License activation failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to activate license", 500)
  }
}
