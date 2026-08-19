/**
 * License service — shared business logic for Local / Desktop licensing.
 *
 * This module centralizes the signing-key resolution, seat-cap enforcement,
 * and license-file issuance so that the API routes stay thin. The private key
 * is resolved from `LICENSE_SIGNING_PRIVATE_KEY` (dev) or Azure Key Vault
 * (production — TODO: wire Key Vault client).
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { env } from "@lyrashield/config"
import { getSystemPrisma } from "@lyrashield/db"
import { getLocalSku, type LocalSkuId } from "@lyrashield/pricing"
import { signLicense, type LicenseFile, type LicenseSku } from "@lyrashield/licenses"
import { logger } from "@lyrashield/logger"

/** HTTP header name for the internal API key used by server-to-server routes. */
export const INTERNAL_API_KEY_HEADER = "X-LyraShield-Internal-Key"

/** Individual licenses allow up to 3 machines. Team licenses allow 1 machine per seat. */
export const INDIVIDUAL_MACHINE_CAP = 3

/** Days of update eligibility added per renewal. */
const RENEWAL_DAYS = 365

/**
 * Resolve the perpetual-fallback build SERVER-SIDE.
 *
 * At issuance and renewal this is the latest published Local/Desktop build
 * (`LICENSE_PUBLISHED_BUILD`). Client-supplied `currentBuild` is ignored —
 * trusting it would let a buyer pin an arbitrary keep-forever window.
 */
export function resolvePublishedFallbackBuild(): string | null {
  const published = env.LICENSE_PUBLISHED_BUILD?.trim()
  return published ? published : null
}

/**
 * Lazily-built Azure Key Vault secret client for the production signing key.
 *
 * The import of `@azure/keyvault-secrets` / `@azure/identity` is dynamic and
 * deferred to first use so that local development and CI (which never set
 * LYRASHIELD_KEY_VAULT_NAME) do not pay the import cost and never require the
 * Azure SDK to be present in a meaningful way. The resolved client is cached
 * for the process lifetime.
 */
let keyVaultSecretsClient: import("@azure/keyvault-secrets").SecretClient | null = null

function getKeyVaultSecretsClient(): import("@azure/keyvault-secrets").SecretClient {
  if (keyVaultSecretsClient) return keyVaultSecretsClient
  const vaultName = env.LYRASHIELD_KEY_VAULT_NAME
  if (!vaultName) {
    throw new Error(
      "LYRASHIELD_KEY_VAULT_NAME is not set — cannot resolve the signing key from Key Vault"
    )
  }
  // Deferred require so the Azure SDK is only loaded when actually used.
  const { SecretClient } =
    require("@azure/keyvault-secrets") as typeof import("@azure/keyvault-secrets")
  const { DefaultAzureCredential } = require("@azure/identity") as typeof import("@azure/identity")
  keyVaultSecretsClient = new SecretClient(
    `https://${vaultName}.vault.azure.net`,
    new DefaultAzureCredential()
  )
  return keyVaultSecretsClient
}

/** Cached Key Vault private key PEM, fetched once per process. */
let cachedKeyVaultPrivateKey: string | null = null

/**
 * Whether the production signing key is sourced from Azure Key Vault.
 * True only in production AND when a vault name is configured; otherwise the
 * env-provided `LICENSE_SIGNING_PRIVATE_KEY` (dev / CI) is used.
 */
function isProductionKeyVault(): boolean {
  return env.NODE_ENV === "production" && Boolean(env.LYRASHIELD_KEY_VAULT_NAME)
}

/**
 * Resolve the ed25519 private key PEM for signing.
 *
 * Resolution order:
 * 1. Production + `LYRASHIELD_KEY_VAULT_NAME` set → fetch the key from Azure
 *    Key Vault via managed identity (DefaultAzureCredential). Cached per
 *    process. Fails closed (throws) if the vault is unreachable or the secret
 *    is missing — never falls back to env in production-with-vault, so a
 *    mis-provisioned vault cannot silently sign with a stale env key.
 * 2. Otherwise → the `LICENSE_SIGNING_PRIVATE_KEY` env var (dev / CI).
 */
export async function resolveSigningPrivateKey(): Promise<string> {
  if (isProductionKeyVault()) {
    if (cachedKeyVaultPrivateKey) return cachedKeyVaultPrivateKey
    const client = getKeyVaultSecretsClient()
    const secretName = env.LICENSE_SIGNING_PRIVATE_KEY_SECRET_NAME
    const secret = await client.getSecret(secretName)
    const value = secret.value
    if (!value || !value.includes("-----BEGIN")) {
      throw new Error(
        `Key Vault secret "${secretName}" is missing or not a PEM key. ` +
          "Provision it per docs/ops/license-signing-keys-runbook.md."
      )
    }
    cachedKeyVaultPrivateKey = value
    return value
  }

  const key = env.LICENSE_SIGNING_PRIVATE_KEY
  if (!key) {
    throw new Error(
      "LICENSE_SIGNING_PRIVATE_KEY is not set. Generate a dev key with: " +
        "openssl genpkey -algorithm ed25519 -out license_private.pem"
    )
  }
  return key
}

/** Resolve the signing key identifier (for rotation / revocation).
 *
 * B-L05: In production, LICENSE_SIGNING_KEY_ID must be set explicitly.
 * The fallback "license-key-v1" is only for development.
 */
export function resolveSigningKeyId(): string {
  const keyId = env.LICENSE_SIGNING_KEY_ID
  if (!keyId && env.NODE_ENV === "production") {
    throw new Error("LICENSE_SIGNING_KEY_ID is required in production")
  }
  return keyId || "license-key-v1"
}

/**
 * Resolve the ed25519 public key (SPKI PEM) for license verification.
 *
 * Resolution order:
 * 1. `LICENSE_SIGNING_PUBLIC_KEY` env var (explicit, supports key separation).
 * 2. Derived from `LICENSE_SIGNING_PRIVATE_KEY` at runtime.
 *
 * The server must NEVER accept a public key from the client — doing so would
 * allow an attacker to forge a license and supply their own key for verification.
 */
export async function resolveSigningPublicKey(): Promise<string> {
  // 1. Explicit env var (supports key separation without a vault round-trip).
  if (env.LICENSE_SIGNING_PUBLIC_KEY) {
    return env.LICENSE_SIGNING_PUBLIC_KEY
  }

  // 2. Production + vault configured → fetch the public key secret.
  if (isProductionKeyVault()) {
    const client = getKeyVaultSecretsClient()
    const secretName = env.LICENSE_SIGNING_PUBLIC_KEY_SECRET_NAME
    const secret = await client.getSecret(secretName)
    if (secret.value && secret.value.includes("-----BEGIN")) {
      return secret.value
    }
    // Fall through to deriving from the (vault-sourced) private key.
  }

  // 3. Derive the public key from the private key.
  const privateKeyPem = await resolveSigningPrivateKey()
  const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" })
  const derivedPublicKey = createPublicKey(privateKey)
  return derivedPublicKey.export({ type: "spki", format: "pem" }).toString()
}

/**
 * Verify the internal API key on server-to-server routes (license issue/renew).
 *
 * When `LYRASHIELD_INTERNAL_API_KEY` is set, the request must include the
 * `X-LyraShield-Internal-Key` header matching that value. When the env var is
 * unset (dev/test), the check is skipped with a warning so local development
 * and e2e tests are not blocked.
 *
 * @returns `null` if the check passes, or a `Response` (403) if it fails.
 */
export function requireInternalApiKey(request: Request): Response | null {
  const expectedKey = env.LYRASHIELD_INTERNAL_API_KEY

  // Dev/test convenience: if no internal key is configured, allow the request.
  if (!expectedKey) {
    logger.warn(
      "LYRASHIELD_INTERNAL_API_KEY is not set — internal API routes are unauthenticated. " +
        "Set this variable in production to protect license issue/renew endpoints."
    )
    return null
  }

  const providedKey = request.headers.get(INTERNAL_API_KEY_HEADER)
  // B-M01: Use constant-time comparison to prevent timing side-channel attacks.
  // A plain !== comparison leaks byte-by-byte timing information that can
  // be used to recover the key over many requests.
  if (!providedKey) {
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: "FORBIDDEN", message: "Missing or invalid internal API key" },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    )
  }

  const provided = Buffer.from(providedKey)
  const expected = Buffer.from(expectedKey)
  // Length guard: timingSafeEqual throws on different lengths, which would
  // leak the key length via timing. Compare lengths first, then content.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: "FORBIDDEN", message: "Missing or invalid internal API key" },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    )
  }

  return null
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

/** Check whether a SKU is a team license (per-seat, min 3 seats). */
export function isTeamSku(sku: LocalSkuId): boolean {
  return sku === "team_perpetual" || sku === "team_subscription"
}

/**
 * Minimum seats for a team license. The founder-confirmed spec requires
 * "Team $99/seat perpetual (min 3)" — a team SKU may not be issued for fewer
 * than this many seats.
 */
export const TEAM_MIN_SEATS = 3

/**
 * Validate the seat count against the SKU's rules.
 *
 * - Individual SKUs: 1 seat (the issue route's Zod schema already enforces
 *   min 1, and the machine cap is fixed at 3 machines regardless).
 * - Team SKUs: at least {@link TEAM_MIN_SEATS} seats.
 *
 * Throws if the seat count violates the SKU's minimum. Callers should catch
 * and map to a 400 response.
 */
export function validateSeatCountForSku(sku: LocalSkuId, seatCount: number): void {
  if (isTeamSku(sku) && seatCount < TEAM_MIN_SEATS) {
    throw new Error(
      `Team licenses require a minimum of ${TEAM_MIN_SEATS} seats (received ${seatCount})`
    )
  }
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
  // License issuance is called from workspace-less routes (activate, renew,
  // sync connect) — the license is FORCE-RLS-scoped and may be NULL-workspaceId,
  // so the RLS-scoped client would not see it. Use the system client.
  const systemPrisma = getSystemPrisma()
  const license = await systemPrisma.license.findUniqueOrThrow({ where: { id: licenseId } })

  if (license.revoked) {
    throw new Error("LICENSE_REVOKED")
  }

  const privateKey = await resolveSigningPrivateKey()
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

  await systemPrisma.license.update({
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

/**
 * Issue a license for a Polar one-time order of a Local SKU product.
 *
 * Called by the billing webhook handler when a `order.paid` event arrives
 * for a product ID that maps to a Local SKU. Creates a `License` +
 * `LicenseKey` and issues a signed license file. Idempotent on orderId —
 * if a license was already issued for this order, returns the existing one.
 *
 * This is the Track B integration point called from Track A's webhook route.
 */
export async function issueLicenseForPolarOrder(params: {
  productId: string
  buyerEmail: string
  seatCount: number
  orderId: string
  workspaceId?: string
}): Promise<{ licenseId: string; alreadyIssued: boolean }> {
  const { productId, buyerEmail, seatCount, orderId, workspaceId } = params
  const fallbackBuild = resolvePublishedFallbackBuild()

  // Resolve the SKU from the product ID map.
  const productMap = parseLocalProductIds()
  const skuEntry = Object.entries(productMap).find(([, pid]) => pid === productId)
  if (!skuEntry) {
    throw new Error(`Product ID ${productId} is not a recognized Local SKU product`)
  }
  const sku = skuEntry[0] as LocalSkuId

  // B-L02: Enforce the team-SKU minimum seat count (spec: min 3 seats).
  validateSeatCountForSku(sku, seatCount)

  // NULL-workspaceId License/LicenseKey rows are FORCE-RLS-scoped and invisible
  // to the ordinary NOBYPASSRLS client. Issuance is a workspace-less system
  // operation — use the system client for both the idempotency lookup and the
  // create (mirrors activate/renew).
  const systemPrisma = getSystemPrisma()

  // B-L09: Idempotency with unique constraint catch instead of TOCTOU findFirst.
  const existingKey = await systemPrisma.licenseKey.findFirst({
    where: { issuedByProvider: `polar:${orderId}` },
  })
  if (existingKey) {
    logger.info("License already issued for order — returning existing", { orderId })
    return { licenseId: existingKey.licenseId, alreadyIssued: true }
  }

  const updateEligibleUntil = computeUpdateEligibleUntil(sku)
  const rawKey = generateLicenseKey()
  const keyHash = hashLicenseKey(rawKey)

  let license
  try {
    license = await systemPrisma.$transaction(async (tx) => {
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
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      const existing = await systemPrisma.licenseKey.findFirst({
        where: { issuedByProvider: `polar:${orderId}` },
      })
      if (existing) {
        logger.info("License race resolved — returning existing", { orderId })
        return { licenseId: existing.licenseId, alreadyIssued: true }
      }
    }
    throw error
  }

  await issueSignedLicense(license.id, fallbackBuild)

  // TODO(email): Send the license key + license file to buyerEmail via Brevo.
  logger.info("License issued for Polar order", {
    licenseId: license.id,
    buyerEmail,
    sku,
    orderId,
  })

  return { licenseId: license.id, alreadyIssued: false }
}
