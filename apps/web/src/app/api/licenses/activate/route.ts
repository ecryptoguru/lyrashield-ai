import { z } from "zod"
import { prisma, getSystemPrisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { encodeLicenseBlob } from "@lyrashield/licenses"
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
    // License activation is a workspace-less global operation: the key-hash
    // lookup must not be scoped to a caller workspace. License keys for direct
    // purchases are NULL-workspaceId and FORCE-RLS-scoped, so the RLS-scoped
    // client would not find them under a NOBYPASSRLS role (USING workspaceId =
    // current_workspace_id() yields no rows when there is no context). Use the
    // system client (cross-workspace privileged read) for this lookup.
    const systemPrisma = getSystemPrisma()
    const licenseKeyRow = await systemPrisma.licenseKey.findUnique({
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
    // Use the system client — the activation is workspace-less (no caller
    // workspace context) and License/LicenseActivation are FORCE-RLS-scoped, so
    // the RLS-scoped client would not see the rows under a NOBYPASSRLS role.
    const result = await systemPrisma.$transaction(async (tx) => {
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

    // B-L01: Audit log the activation.
    // AuditLog.workspaceId is a hard FK to Workspace — only write when the
    // license is actually linked to a workspace. A not-yet-linked license
    // (a direct Polar purchase with no workspace) has workspaceId NULL, and
    // writing `license.id` into a Workspace FK column would violate the FK
    // (silently swallowed by the catch). Skip the audit in that case.
    if (license.workspaceId) {
      await prisma.auditLog
        .create({
          data: {
            workspaceId: license.workspaceId,
            action: "license.activated",
            resourceType: "license",
            resourceId: license.id,
            metadata: { machineId, machineCount: result.machineIds.length, sku },
          },
        })
        .catch(() => {})
    }

    return apiSuccess(
      {
        license: licenseFile,
        blob: encodeLicenseBlob(licenseFile),
        licenseId: license.id,
      },
      200
    )
  } catch (error) {
    logger.error("License activation failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to activate license", 500)
  }
}
