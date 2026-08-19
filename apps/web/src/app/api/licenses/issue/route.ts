import { z } from "zod"
import { prisma, getSystemPrisma } from "@lyrashield/db"
import { type LocalSkuId, teamVolumeDiscountPct, teamOrderTotal } from "@lyrashield/pricing"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { encodeLicenseBlob } from "@lyrashield/licenses"
import {
  generateLicenseKey,
  hashLicenseKey,
  computeUpdateEligibleUntil,
  issueSignedLicense,
  parseLocalProductIds,
  requireInternalApiKey,
  resolvePublishedFallbackBuild,
  sendLicenseIssuedEmail,
  validateSeatCountForSku,
} from "../../../../lib/licenses/license-service"

export const dynamic = "force-dynamic"

const IssueSchema = z.object({
  /** The Polar product ID that was purchased. */
  productId: z.string().min(1),
  /** Buyer email — the license key is emailed here. */
  buyerEmail: z.string().email(),
  /** Number of seats (1 for individual, N for team). */
  seatCount: z.coerce.number().int().min(1).max(1000).default(1),
  /** Optional workspace ID if the buyer has an existing account. */
  workspaceId: z.string().optional(),
  /** Polar order ID for idempotency. */
  orderId: z.string().min(1),
})

/**
 * POST /api/licenses/issue
 *
 * Internal endpoint called by the Polar `order.paid` webhook when a Local SKU
 * product is purchased. Creates a `License` + `LicenseKey` and emails the
 * license key to the buyer.
 *
 * This route is protected by an internal API key (`X-LyraShield-Internal-Key`)
 * so that external users cannot generate free licenses. The primary webhook
 * handler calls `issueLicenseForPolarOrder()` directly; this route is a
 * fallback/internal API.
 *
 * Idempotency: the `orderId` is checked against existing licenses to avoid
 * duplicate issuance on webhook retries.
 *
 * perpetualFallbackBuild is resolved server-side from LICENSE_PUBLISHED_BUILD.
 * A client-supplied currentBuild is ignored.
 */
export async function POST(request: Request) {
  try {
    // C-01: Require internal API key — this endpoint must not be callable by
    // external users. Without this check anyone could generate free licenses.
    const authResponse = requireInternalApiKey(request)
    if (authResponse) return authResponse

    const body: unknown = await request.json().catch(() => null)
    const parsed = IssueSchema.safeParse(body)
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { productId, buyerEmail, seatCount, workspaceId, orderId } = parsed.data
    const fallbackBuild = resolvePublishedFallbackBuild()

    // Resolve the SKU from the product ID map.
    const productMap = parseLocalProductIds()
    const skuEntry = Object.entries(productMap).find(([, pid]) => pid === productId)
    if (!skuEntry) {
      return apiError(
        "PRODUCT_NOT_LOCAL",
        `Product ID ${productId} is not a recognized Local SKU product`,
        400
      )
    }
    const sku = skuEntry[0] as LocalSkuId

    // B-L02: Enforce the team-SKU minimum seat count (spec: min 3 seats).
    // Individual SKUs allow 1 seat; team SKUs require >= 3.
    try {
      validateSeatCountForSku(sku, seatCount)
    } catch (err) {
      return apiError(
        "INVALID_SEAT_COUNT",
        err instanceof Error ? err.message : "Invalid seat count for SKU",
        400
      )
    }

    const systemPrisma = getSystemPrisma()
    const existingKey = await systemPrisma.licenseKey.findFirst({
      where: { issuedByProvider: `polar:${orderId}` },
    })
    if (existingKey) {
      logger.info("License already issued for order — returning existing", { orderId })
      const existingLicense = await systemPrisma.license.findUniqueOrThrow({
        where: { id: existingKey.licenseId },
      })
      return apiSuccess({ licenseId: existingLicense.id, alreadyIssued: true }, 200)
    }

    const updateEligibleUntil = computeUpdateEligibleUntil(sku)
    const rawKey = generateLicenseKey()
    const keyHash = hashLicenseKey(rawKey)

    const license = await systemPrisma.$transaction(async (tx) => {
      const created = await tx.license.create({
        data: {
          workspaceId: workspaceId || null,
          ownerEmail: buyerEmail,
          sku,
          seatCount,
          machineIds: [],
          updateEligibleUntil,
          perpetualFallbackBuild: fallbackBuild,
          signingKeyId: "pending",
          signature: "pending",
          issuedAt: new Date(),
        },
      })

      await tx.licenseKey.create({
        data: {
          licenseId: created.id,
          workspaceId: workspaceId || null,
          keyHash,
          issuedByProvider: `polar:${orderId}`,
          providerProductId: productId,
        },
      })

      return created
    })

    const licenseFile = await issueSignedLicense(license.id, fallbackBuild)

    // Email the buyer their raw key + signed license file. Detached and
    // non-blocking — a mail failure never fails the issuance response.
    sendLicenseIssuedEmail({
      buyerEmail,
      rawLicenseKey: rawKey,
      licenseBlob: encodeLicenseBlob(licenseFile),
      sku,
    })

    logger.info("License issued", {
      licenseId: license.id,
      buyerEmail,
      sku,
      orderId,
    })

    const volumeDiscountPct = teamVolumeDiscountPct(sku, seatCount)
    const orderTotalUsd = teamOrderTotal(sku, seatCount)
    if (workspaceId) {
      await prisma.auditLog
        .create({
          data: {
            workspaceId,
            action: "license.issued",
            resourceType: "license",
            resourceId: license.id,
            metadata: {
              buyerEmail,
              sku,
              orderId,
              seatCount,
              volumeDiscountPct,
              orderTotalUsd,
            },
          },
        })
        .catch(() => {})
    }

    const maskedKey = rawKey.slice(0, 8) + "••••••••" + rawKey.slice(-4)
    return apiSuccess(
      {
        licenseId: license.id,
        licenseKeyMasked: maskedKey,
        licenseFile,
      },
      201
    )
  } catch (error) {
    logger.error("License issuance failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to issue license", 500)
  }
}
