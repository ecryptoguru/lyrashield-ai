/**
 * License fulfillment from provider orders (webhook Track B).
 *
 * Generalized from the Polar-only path so Razorpay local purchases mint
 * licenses too. Idempotency via partial unique index on `issuedByProvider`
 * (migration 20260822220000) — insert-first atomic claim, P2002 loser fetches
 * existing idempotently. Delivery is tracked (fulfillmentStatus +
 * deliveryAttempts) and retryable via webhook-track queue before track
 * completion. Email never contains raw key — one-time retrieval token link
 * instead. Retrieval route is one-time, hashed, expiring.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomUUID,
  randomBytes,
} from "node:crypto"
import { DefaultAzureCredential } from "@azure/identity"
import { SecretClient } from "@azure/keyvault-secrets"
import { env } from "@lyrashield/config"
import { getSystemPrisma } from "@lyrashield/db"
import { getLocalSku, LOCAL_SKU_MAP, type LocalSkuId } from "@lyrashield/pricing"
import {
  signLicense,
  encodeLicenseBlob,
  type LicenseFile,
  type LicenseSku,
} from "@lyrashield/licenses"
import { logger } from "@lyrashield/logger"

/** Individual licenses allow up to 3 machines. Team licenses allow 1 machine per seat. */
export const INDIVIDUAL_MACHINE_CAP = 3

/** Days of update eligibility added per renewal. */
const RENEWAL_DAYS = 365

/**
 * Minimum seats for a team license. The founder-confirmed spec requires
 * "Team $99/seat perpetual (min 3)" — a team SKU may not be issued for fewer
 * than this many seats.
 */
export const TEAM_MIN_SEATS = 3

/** One-time retrieval token expiry in days */
export const RETRIEVAL_TOKEN_EXPIRY_DAYS = 7
export const RETRIEVAL_TOKEN_EXPIRY_MS = RETRIEVAL_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000

/** Fulfillment lifecycle */
export const FULFILLMENT_STATUS = {
  MINTED: "MINTED",
  DELIVERING: "DELIVERING",
  DELIVERED: "DELIVERED",
  DELIVERY_FAILED: "DELIVERY_FAILED",
  // legacy alias
  FAILED: "DELIVERY_FAILED",
} as const
export type FulfillmentStatus = (typeof FULFILLMENT_STATUS)[keyof typeof FULFILLMENT_STATUS]

/**
 * Resolve the perpetual-fallback build SERVER-SIDE.
 */
export function resolvePublishedFallbackBuild(): string | null {
  const published = env.LICENSE_PUBLISHED_BUILD?.trim()
  return published ? published : null
}

let keyVaultSecretsClient: SecretClient | null = null

function getKeyVaultSecretsClient(): SecretClient {
  if (keyVaultSecretsClient) return keyVaultSecretsClient
  const vaultName = env.LYRASHIELD_KEY_VAULT_NAME
  if (!vaultName) {
    throw new Error(
      "LYRASHIELD_KEY_VAULT_NAME is not set — cannot resolve the signing key from Key Vault"
    )
  }
  keyVaultSecretsClient = new SecretClient(
    `https://${vaultName}.vault.azure.net`,
    new DefaultAzureCredential()
  )
  return keyVaultSecretsClient
}

let cachedKeyVaultPrivateKey: string | null = null

function isProductionKeyVault(): boolean {
  const isLocalE2e =
    env.LICENSE_SIGNING_KEY_ID === "e2e-license-key-v1" &&
    (env.BETTER_AUTH_URL === "http://127.0.0.1:3100" ||
      env.BETTER_AUTH_URL === "http://localhost:3100")
  return env.NODE_ENV === "production" && !isLocalE2e
}

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

export function resolveSigningKeyId(): string {
  const keyId = env.LICENSE_SIGNING_KEY_ID
  if (!keyId && env.NODE_ENV === "production") {
    throw new Error("LICENSE_SIGNING_KEY_ID is required in production")
  }
  return keyId || "license-key-v1"
}

export async function resolveSigningPublicKey(): Promise<string> {
  if (env.LICENSE_SIGNING_PUBLIC_KEY) {
    return env.LICENSE_SIGNING_PUBLIC_KEY
  }
  if (isProductionKeyVault()) {
    const client = getKeyVaultSecretsClient()
    const secretName = env.LICENSE_SIGNING_PUBLIC_KEY_SECRET_NAME
    const secret = await client.getSecret(secretName)
    if (secret.value && secret.value.includes("-----BEGIN")) {
      return secret.value
    }
  }
  const privateKeyPem = await resolveSigningPrivateKey()
  const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" })
  const derivedPublicKey = createPublicKey(privateKey)
  return derivedPublicKey.export({ type: "spki", format: "pem" }).toString()
}

export function machineCapForSku(sku: LocalSkuId, seatCount: number): number {
  if (sku === "individual_launch" || sku === "individual_regular") {
    return INDIVIDUAL_MACHINE_CAP
  }
  return seatCount
}

export function isIndividualSku(sku: LocalSkuId): boolean {
  return sku === "individual_launch" || sku === "individual_regular"
}

export function isTeamSku(sku: LocalSkuId): boolean {
  return sku === "team_perpetual" || sku === "team_subscription"
}

export function validateSeatCountForSku(sku: LocalSkuId, seatCount: number): void {
  if (isTeamSku(sku) && seatCount < TEAM_MIN_SEATS) {
    throw new Error(
      `Team licenses require a minimum of ${TEAM_MIN_SEATS} seats (received ${seatCount})`
    )
  }
}

export function computeUpdateEligibleUntil(sku: LocalSkuId, from = new Date()): Date {
  const def = getLocalSku(sku)
  const days = def?.updateDays ?? RENEWAL_DAYS
  const result = new Date(from)
  result.setDate(result.getDate() + days)
  return result
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function hashLicenseKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex")
}

export function generateLicenseKey(): string {
  return `LYRA-${randomUUID().toUpperCase()}`
}

export function generateRetrievalToken(): string {
  // 32 bytes hex + uuid for entropy
  return randomBytes(32).toString("hex") + "-" + randomUUID()
}

export function hashRetrievalToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

const RETRIEVAL_KEY_PREFIX = "v1:"
const RETRIEVAL_KEY_INFO = "lyrashield-license-retrieval/v1"

/**
 * Encrypt one-time license retrieval material at rest. This intentionally uses
 * a purpose-derived key, so the Better Auth secret is never used directly for
 * ciphertext and a compromise of another encrypted value cannot cross-decrypt
 * this payload.
 */
export function encryptRetrievalKey(rawKey: string): string {
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(env.BETTER_AUTH_SECRET), "", RETRIEVAL_KEY_INFO, 32)
  )
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const ciphertext = Buffer.concat([cipher.update(rawKey, "utf8"), cipher.final()])
  return `${RETRIEVAL_KEY_PREFIX}${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")}`
}

export function decryptRetrievalKey(stored: string): string {
  // Compatibility for retrieval links minted before encrypted storage. New
  // writes always use v1; callers clear this material immediately after use.
  if (!stored.startsWith(RETRIEVAL_KEY_PREFIX)) return stored
  const encrypted = Buffer.from(stored.slice(RETRIEVAL_KEY_PREFIX.length), "base64url")
  if (encrypted.length <= 28) throw new Error("retrieval key ciphertext is malformed")
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(env.BETTER_AUTH_SECRET), "", RETRIEVAL_KEY_INFO, 32)
  )
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12))
  decipher.setAuthTag(encrypted.subarray(12, 28))
  return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString("utf8")
}

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

export async function issueSignedLicense(
  licenseId: string,
  perpetualFallbackBuild: string | null
): Promise<LicenseFile> {
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

function resolveLocalSkuFromProductId(productId: string): LocalSkuId | null {
  if (productId in LOCAL_SKU_MAP) return productId as LocalSkuId
  const productMap = parseLocalProductIds()
  const entry = Object.entries(productMap).find(([, pid]) => pid === productId)
  return entry ? (entry[0] as LocalSkuId) : null
}

/**
 * Send retrieval link email (one-time token, expiring). Throws on Brevo failure
 * so caller can mark DELIVERY_FAILED and keep webhook track retryable.
 * Never logs token.
 */
export async function sendLicenseRetrievalEmail(params: {
  buyerEmail: string
  retrievalToken: string
  retrievalExpiresAt: Date
  sku: string
  licenseBlob?: string
}): Promise<void> {
  const { buyerEmail, retrievalToken, retrievalExpiresAt, sku } = params
  const isProd = env.NODE_ENV === "production"

  // In non-production, log minimally without token
  if (!isProd) {
    logger.info("License retrieval email not sent in development", { sku })
    return
  }
  if (!env.BREVO_API_KEY) {
    logger.error("BREVO_API_KEY is required to send the license email in production", { sku })
    throw new Error("brevo_api_key_missing")
  }
  const apiKey = env.BREVO_API_KEY
  const appUrl = env.NEXT_PUBLIC_APP_URL || "https://app.lyrashieldai.com"
  // URL fragments are never sent in HTTP requests, so proxies and access logs cannot capture the token.
  const retrievalUrl = `${appUrl.replace(/\/$/, "")}/licenses/retrieve#token=${encodeURIComponent(retrievalToken)}`
  const expiryStr = retrievalExpiresAt.toISOString().slice(0, 10)

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: { email: env.EMAIL_FROM || "noreply@lyrashieldai.com" },
      to: [{ email: buyerEmail }],
      subject: "Your LyraShield Local license — retrieval link inside",
      htmlContent:
        `<p>Thanks for your purchase. Your LyraShield Local license (${escapeHtml(sku)}) is ready.</p>` +
        `<p><strong>One-time retrieval link</strong> (expires ${escapeHtml(expiryStr)}, single use):</p>` +
        `<p><a href="${escapeHtml(retrievalUrl)}">${escapeHtml(retrievalUrl)}</a></p>` +
        `<p>Open the link, then confirm retrieval. Your browser removes the token from the address before contacting the retrieval API.</p>` +
        `<p>You can retrieve your license key and signed license file <strong>once</strong>. After first retrieval or expiry the link becomes invalid. Keep your key safe.</p>` +
        `<p>If you need help, contact support with your order email.</p>`,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    logger.error("Failed to send license email via Brevo", {
      status: res.status,
      sku,
    })
    throw new Error(`brevo_delivery_failed:${res.status}:${body.slice(0, 200)}`)
  }
}

/**
 * Back-compat wrapper used by old call sites — now delegates to retrieval email
 * without logging raw key. Kept to avoid breaking imports; new code should call
 * sendLicenseRetrievalEmail directly. The rawLicenseKey param is ignored except
 * for logging sku; email never contains raw key.
 */
export function sendLicenseIssuedEmail(params: {
  buyerEmail: string
  rawLicenseKey: string
  licenseBlob: string
  sku: string
  retrievalToken?: string
  retrievalExpiresAt?: Date
}): void {
  // Fire-and-forget wrapper for legacy callers (e.g., issue route before migration).
  // New fulfillment path uses sendLicenseRetrievalEmail with await and delivery tracking.
  if (params.retrievalToken && params.retrievalExpiresAt) {
    void sendLicenseRetrievalEmail({
      buyerEmail: params.buyerEmail,
      retrievalToken: params.retrievalToken,
      retrievalExpiresAt: params.retrievalExpiresAt,
      sku: params.sku,
    }).catch((err) => {
      logger.error("Exception while sending license email", {
        error: err instanceof Error ? err.message : String(err),
        sku: params.sku,
      })
    })
    return
  }
  // If no retrieval token provided, generate a deprecation warning — caller should migrate.
  logger.warn("sendLicenseIssuedEmail called without retrieval token — email not sent", {
    sku: params.sku,
  })
}

/**
 * Issue a license for a provider one-time order of a Local SKU product.
 *
 * Idempotent via partial unique index on issuedByProvider (insert-first).
 * Concurrent losers get P2002 and fetch existing idempotently.
 * Delivery attempts are tracked (fulfillmentStatus + deliveryAttempts) and
 * Brevo failures are retryable via the webhook-track queue (throw before
 * track completion). Email contains retrieval link + expiry, NOT raw key.
 * Retrieval token is hashed sha256 with expiry and usedAt for one-time use.
 */
export async function issueLicenseForProviderOrder(params: {
  provider: string
  productId: string
  buyerEmail: string
  seatCount: number
  orderId: string
  workspaceId?: string
}): Promise<{ licenseId: string; alreadyIssued: boolean }> {
  const { provider, productId, buyerEmail, seatCount, orderId, workspaceId } = params
  const fallbackBuild = resolvePublishedFallbackBuild()

  const sku = resolveLocalSkuFromProductId(productId)
  if (!sku) {
    throw new Error(`Product ID ${productId} is not a recognized Local SKU product`)
  }

  validateSeatCountForSku(sku, seatCount)

  const issuedByProvider = `${provider}:${orderId}`
  const systemPrisma = getSystemPrisma()

  const updateEligibleUntil = computeUpdateEligibleUntil(sku)
  const rawKey = generateLicenseKey()
  const keyHash = hashLicenseKey(rawKey)
  const retrievalToken = generateRetrievalToken()
  const retrievalTokenHash = hashRetrievalToken(retrievalToken)
  const retrievalExpiresAt = new Date(Date.now() + RETRIEVAL_TOKEN_EXPIRY_MS)

  // Atomic claim: insert-first using unique index
  try {
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
          issuedByProvider,
          providerProductId: productId,
          fulfillmentStatus: FULFILLMENT_STATUS.MINTED,
          deliveryAttempts: 0,
          retrievalTokenHash,
          retrievalTokenExpiresAt: retrievalExpiresAt,
          retrievalTokenUsedAt: null,
          retrievalRawKey: encryptRetrievalKey(rawKey),
        },
      })

      return created
    })

    // Issue signed file outside creation transaction
    await issueSignedLicense(license.id, fallbackBuild)

    // Delivery: mark DELIVERING, attempt email, then DELIVERED or DELIVERY_FAILED
    await systemPrisma.licenseKey.update({
      where: { licenseId: license.id },
      data: {
        fulfillmentStatus: FULFILLMENT_STATUS.DELIVERING,
        deliveryAttempts: { increment: 1 },
      },
    })

    try {
      await sendLicenseRetrievalEmail({
        buyerEmail,
        retrievalToken,
        retrievalExpiresAt,
        sku,
      })
    } catch (deliveryError) {
      const msg = deliveryError instanceof Error ? deliveryError.message : String(deliveryError)
      await systemPrisma.licenseKey.update({
        where: { licenseId: license.id },
        data: {
          fulfillmentStatus: FULFILLMENT_STATUS.DELIVERY_FAILED,
          lastDeliveryError: msg.slice(0, 500),
        },
      })
      logger.error("License delivery failed — will retry via webhook track", {
        provider,
        orderId,
        sku,
      })
      throw new Error(`license_delivery_failed:${msg.slice(0, 200)}`)
    }

    await systemPrisma.licenseKey.update({
      where: { licenseId: license.id },
      data: {
        fulfillmentStatus: FULFILLMENT_STATUS.DELIVERED,
        lastDeliveryError: null,
      },
    })

    logger.info("License issued for provider order", {
      provider,
      licenseId: license.id,
      sku,
      orderId,
    })

    return { licenseId: license.id, alreadyIssued: false }
  } catch (error) {
    const isP2002 =
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"

    // P2002 on issuedByProvider means concurrent winner already inserted
    if (isP2002) {
      const existing = await systemPrisma.licenseKey.findFirst({
        where: { issuedByProvider },
        include: { license: true },
      })
      if (existing) {
        // If already delivered, idempotent success
        if (existing.fulfillmentStatus === FULFILLMENT_STATUS.DELIVERED) {
          logger.info("License race resolved — returning existing delivered", { provider, orderId })
          return { licenseId: existing.licenseId, alreadyIssued: true }
        }

        // A previous attempt may have persisted the license but failed while
        // signing it. Never mark delivery successful until signing converges.
        await issueSignedLicense(
          existing.licenseId,
          existing.license.perpetualFallbackBuild ?? resolvePublishedFallbackBuild()
        )

        // If delivery failed / minted / delivering, retry delivery once before giving up
        // Generate a fresh token for the retry (old token plaintext not available)
        const retryToken = generateRetrievalToken()
        const retryHash = hashRetrievalToken(retryToken)
        const retryExpires = new Date(Date.now() + RETRIEVAL_TOKEN_EXPIRY_MS)

        try {
          await systemPrisma.licenseKey.update({
            where: { id: existing.id },
            data: {
              fulfillmentStatus: FULFILLMENT_STATUS.DELIVERING,
              deliveryAttempts: { increment: 1 },
              retrievalTokenHash: retryHash,
              retrievalTokenExpiresAt: retryExpires,
              retrievalTokenUsedAt: null,
              lastDeliveryError: null,
            },
          })

          const skuForRetry = existing.license.sku
          await sendLicenseRetrievalEmail({
            buyerEmail,
            retrievalToken: retryToken,
            retrievalExpiresAt: retryExpires,
            sku: skuForRetry,
          })

          await systemPrisma.licenseKey.update({
            where: { id: existing.id },
            data: {
              fulfillmentStatus: FULFILLMENT_STATUS.DELIVERED,
              lastDeliveryError: null,
            },
          })

          logger.info("License race resolved — delivery retry succeeded", { provider, orderId })
          return { licenseId: existing.licenseId, alreadyIssued: true }
        } catch (retryError) {
          const msg = retryError instanceof Error ? retryError.message : String(retryError)
          await systemPrisma.licenseKey.update({
            where: { id: existing.id },
            data: {
              fulfillmentStatus: FULFILLMENT_STATUS.DELIVERY_FAILED,
              lastDeliveryError: msg.slice(0, 500),
            },
          })
          logger.error("License race delivery retry failed", { provider, orderId })
          throw new Error(`license_delivery_failed:${msg.slice(0, 200)}`)
        }
      }
    }

    // If error was delivery failure from the newly created license, re-throw as is
    if (error instanceof Error && error.message.startsWith("license_delivery_failed")) {
      throw error
    }

    // For other P2002 that wasn't issuedByProvider (e.g., keyHash collision extremely unlikely), fallback fetch
    if (isP2002) {
      const fallback = await systemPrisma.licenseKey.findFirst({ where: { issuedByProvider } })
      if (fallback) {
        logger.info("License race resolved via fallback", { provider, orderId })
        return { licenseId: fallback.licenseId, alreadyIssued: true }
      }
    }

    throw error
  }
}

/**
 * One-time retrieval via token (hashed lookup). Returns key+blob once,
 * then marks usedAt. Generic 404 for not found / expired / already used.
 * Never logs token or key.
 */
export async function retrieveLicenseByToken(
  token: string
): Promise<{ licenseKey: string; licenseBlob: string; licenseId: string } | null> {
  if (!token || typeof token !== "string" || token.length < 10) return null
  const tokenHash = hashRetrievalToken(token)
  const systemPrisma = getSystemPrisma()

  const keyRow = await systemPrisma.licenseKey.findUnique({
    where: { retrievalTokenHash: tokenHash },
    include: { license: true },
  })

  if (!keyRow) return null
  if (keyRow.retrievalTokenUsedAt) return null
  if (keyRow.retrievalTokenExpiresAt && new Date() > keyRow.retrievalTokenExpiresAt) return null
  if (!keyRow.retrievalRawKey) return null

  const license = keyRow.license
  // Build and sign before consuming the token. A transient signer/Key Vault
  // failure must leave the customer able to retry their one-time link.
  let licenseFile: LicenseFile
  if (!license.signature || license.signature === "pending") {
    licenseFile = await issueSignedLicense(
      license.id,
      license.perpetualFallbackBuild ?? resolvePublishedFallbackBuild()
    )
  } else {
    // Rebuild file without re-signing, using stored signature
    licenseFile = {
      sku: license.sku as LicenseSku,
      seatCount: license.seatCount,
      machineIds: license.machineIds,
      updateEligibleUntil: license.updateEligibleUntil.toISOString(),
      perpetualFallbackBuild: license.perpetualFallbackBuild ?? null,
      signature: license.signature,
      signingKeyId: license.signingKeyId,
      issuedAt: license.issuedAt.toISOString(),
    } as unknown as LicenseFile
  }

  const blob = encodeLicenseBlob(licenseFile)

  const rawKey = decryptRetrievalKey(keyRow.retrievalRawKey)
  // Atomically consume token and remove encrypted key material. Only the
  // winner, which already has the decrypted key in memory, receives it.
  const updated = await systemPrisma.licenseKey.updateMany({
    where: { id: keyRow.id, retrievalTokenUsedAt: null },
    data: { retrievalTokenUsedAt: new Date(), retrievalRawKey: null },
  })
  if (updated.count === 0) return null

  return { licenseKey: rawKey, licenseBlob: blob, licenseId: license.id }
}
