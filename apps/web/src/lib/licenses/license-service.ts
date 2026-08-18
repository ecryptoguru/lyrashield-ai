/**
 * License service — shared business logic for Local / Desktop licensing.
 *
 * This module centralizes the signing-key resolution, seat-cap enforcement,
 * and license-file issuance so that the API routes stay thin. The private key
 * is resolved from `LICENSE_SIGNING_PRIVATE_KEY` (dev) or Azure Key Vault
 * (production — TODO: wire Key Vault client).
 */

import { createHash, randomUUID } from "node:crypto"
import { env } from "@lyrashield/config"
import { prisma } from "@lyrashield/db"
import { getLocalSku, type LocalSkuId } from "@lyrashield/pricing"
import { signLicense, type LicenseFile, type LicenseSku } from "@lyrashield/licenses"
import { logger } from "@lyrashield/logger"

/** Individual licenses allow up to 3 machines. Team licenses allow 1 machine per seat. */
export const INDIVIDUAL_MACHINE_CAP = 3

/** Days of update eligibility added per renewal. */
const RENEWAL_DAYS = 365

/**
 * Resolve the ed25519 private key PEM for signing.
 *
 * In development the key is read from `LICENSE_SIGNING_PRIVATE_KEY`. In
 * production this should be fetched from Azure Key Vault — the TODO below
 * marks the integration point.
 */
export function resolveSigningPrivateKey(): string {
  const key = env.LICENSE_SIGNING_PRIVATE_KEY
  if (!key) {
    throw new Error(
      "LICENSE_SIGNING_PRIVATE_KEY is not set. Generate a dev key with: " +
        "openssl genpkey -algorithm ed25519 -out license_private.pem"
    )
  }
  // TODO(production): fetch from Azure Key Vault instead of env.
  return key
}

/** Resolve the signing key identifier (for rotation / revocation). */
export function resolveSigningKeyId(): string {
  return env.LICENSE_SIGNING_KEY_ID || "license-key-v1"
}

/**
 * Hash a raw license key string for storage / lookup. We store only the hash
 * (SHA-256) so that a database leak does not expose usable license keys.
 */
export function hashLicenseKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex")
}

/** Generate a new random license key string. */
export function generateLicenseKey(): string {
  return `LYRA-${randomUUID().toUpperCase()}`
}

/** Determine the machine cap for a given SKU. */
export function machineCapForSku(sku: LocalSkuId, seatCount: number): number {
  if (sku === "individual_launch" || sku === "individual_regular") {
    return INDIVIDUAL_MACHINE_CAP
  }
  // Team: one machine per seat.
  return seatCount
}

/** Check whether a SKU is an individual (single-user) license. */
export function isIndividualSku(sku: LocalSkuId): boolean {
  return sku === "individual_launch" || sku === "individual_regular"
}

/** Compute the update-eligibility expiry date from a SKU's updateDays. */
export function computeUpdateEligibleUntil(sku: LocalSkuId, from = new Date()): Date {
  const def = getLocalSku(sku)
  const days = def?.updateDays ?? RENEWAL_DAYS
  const result = new Date(from)
  result.setDate(result.getDate() + days)
  return result
}

/**
 * Issue a signed license file from a License database row.
 *
 * Reads the current machineIds and updateEligibleUntil from the row, signs
 * the payload, and persists the signature back to the License record.
 */
export async function issueSignedLicense(
  licenseId: string,
  perpetualFallbackBuild: string | null
): Promise<LicenseFile> {
  const license = await prisma.license.findUniqueOrThrow({ where: { id: licenseId } })

  if (license.revoked) {
    throw new Error("LICENSE_REVOKED")
  }

  const privateKey = resolveSigningPrivateKey()
  const signingKeyId = resolveSigningKeyId()

  const licenseFile = signLicense(
    {
      sku: license.sku as LicenseSku,
      seatCount: license.seatCount,
      machineIds: license.machineIds,
      updateEligibleUntil: license.updateEligibleUntil.toISOString(),
      perpetualFallbackBuild,
    },
    privateKey,
    signingKeyId,
    perpetualFallbackBuild
  )

  await prisma.license.update({
    where: { id: licenseId },
    data: {
      signature: licenseFile.signature,
      signingKeyId,
      issuedAt: new Date(licenseFile.issuedAt),
    },
  })

  logger.info("License file issued", { licenseId, signingKeyId, sku: license.sku })
  return licenseFile
}

/**
 * Parse the POLAR_LOCAL_PRODUCT_IDS env var into a SKU → product ID map.
 * Returns an empty map if unset or invalid.
 */
export function parseLocalProductIds(): Record<string, string> {
  const raw = env.POLAR_LOCAL_PRODUCT_IDS
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    logger.warn("POLAR_LOCAL_PRODUCT_IDS is not valid JSON — ignoring")
    return {}
  }
}
