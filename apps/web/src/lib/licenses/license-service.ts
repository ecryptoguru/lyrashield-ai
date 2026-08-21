/**
 * License service — web-app facade over @lyrashield/billing fulfillment.
 *
 * The signing-key resolution, seat-cap enforcement, and license-file issuance
 * logic now lives in packages/billing/src/license-fulfillment.ts so the
 * worker-side webhook-track retry job can fulfill licenses too. This module
 * keeps the historical import path (`@/lib/licenses/license-service`) stable
 * for existing routes, plus the HTTP-only internal-key guard below.
 */

export {
  issueLicenseForProviderOrder,
  issueSignedLicense,
  resolvePublishedFallbackBuild,
  resolveSigningPrivateKey,
  resolveSigningKeyId,
  resolveSigningPublicKey,
  parseLocalProductIds,
  generateLicenseKey,
  hashLicenseKey,
  sendLicenseIssuedEmail,
  computeUpdateEligibleUntil,
  validateSeatCountForSku,
  machineCapForSku,
  isIndividualSku,
  isTeamSku,
  INDIVIDUAL_MACHINE_CAP,
  TEAM_MIN_SEATS,
} from "@lyrashield/billing"

import { timingSafeEqual } from "node:crypto"
import { createHash } from "node:crypto"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"

/** HTTP header name for the internal API key used by server-to-server routes. */
export const INTERNAL_API_KEY_HEADER = "X-LyraShield-Internal-Key"

/**
 * Verify the internal API key on server-to-server routes (license issue/renew).
 *
 * When `LYRASHIELD_INTERNAL_API_KEY` is set, the request must include the
 * `X-LyraShield-Internal-Key` header matching that value. Comparison is
 * timing-safe: both sides are SHA-256 hashed first so `timingSafeEqual`
 * always receives fixed-length inputs (a differing raw length can no longer
 * short-circuit and leak length information).
 *
 * When the env var is absent or empty, production REJECTS every request
 * (fail closed) while dev/test keep the explicit unauthenticated allow with a
 * warning. Logged failure reasons are bounded ("internal_key_missing" |
 * "internal_key_mismatch") and never include key material.
 *
 * @returns `null` if the check passes, or a `Response` (403) if it fails.
 */
export function requireInternalApiKey(request: Request): Response | null {
  const expectedKey = env.LYRASHIELD_INTERNAL_API_KEY?.trim()
  const providedKey = request.headers.get(INTERNAL_API_KEY_HEADER)

  if (!expectedKey) {
    if (env.NODE_ENV === "production") {
      logger.error("LYRASHIELD_INTERNAL_API_KEY is not set — rejecting internal API request", {
        reason: "internal_key_missing",
      })
      return internalApiKeyFailure()
    }
    // Dev/test convenience: explicit allow so local development and e2e
    // tests are not blocked. Never acceptable in production.
    logger.warn(
      "LYRASHIELD_INTERNAL_API_KEY is not set — internal API routes are unauthenticated. " +
        "Production rejects these requests until the variable is configured."
    )
    return null
  }

  if (!providedKey || !timingSafeEqual(sha256(providedKey), sha256(expectedKey))) {
    logger.warn("Internal API key verification failed", { reason: "internal_key_mismatch" })
    return internalApiKeyFailure()
  }

  return null
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}

/** Generic failure response — never distinguishes why verification failed. */
function internalApiKeyFailure(): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: { code: "FORBIDDEN", message: "Missing or invalid internal API key" },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } }
  )
}
