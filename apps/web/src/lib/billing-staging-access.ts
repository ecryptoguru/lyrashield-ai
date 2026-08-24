import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { billingStagingConfigError, env } from "@lyrashield/config"

export const BILLING_STAGING_ACCESS_COOKIE = "__Host-lyrashield-billing-staging"
export const BILLING_STAGING_ACCESS_MAX_AGE_SECONDS = 8 * 60 * 60

function sessionSignature(token: string, expiresAt: number): string {
  return createHmac("sha256", token)
    .update(`lyrashield:billing-staging-access:v1:${expiresAt}`)
    .digest("base64url")
}

export function isRestrictedBillingStaging(): boolean {
  return env.BILLING_STAGING_ADMISSION === "restricted" && billingStagingConfigError(env) === null
}

export function isValidBillingStagingToken(provided: string): boolean {
  const expected = env.BILLING_STAGING_ACCESS_TOKEN
  if (!isRestrictedBillingStaging() || !expected || !provided) return false
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest()
  )
}

export function createBillingStagingAccessCookieValue(now = Date.now()): string | null {
  const token = env.BILLING_STAGING_ACCESS_TOKEN
  if (!isRestrictedBillingStaging() || !token) return null
  const expiresAt = now + BILLING_STAGING_ACCESS_MAX_AGE_SECONDS * 1000
  return `${expiresAt}.${sessionSignature(token, expiresAt)}`
}

export function hasBillingStagingAccess(request: Request, now = Date.now()): boolean {
  const token = env.BILLING_STAGING_ACCESS_TOKEN
  if (!isRestrictedBillingStaging() || !token) return false
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${BILLING_STAGING_ACCESS_COOKIE}=`))
    ?.slice(BILLING_STAGING_ACCESS_COOKIE.length + 1)
  if (!cookie) return false
  const [rawExpiry, signature, extra] = cookie.split(".")
  const expiresAt = Number(rawExpiry)
  if (
    extra !== undefined ||
    !signature ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + BILLING_STAGING_ACCESS_MAX_AGE_SECONDS * 1000
  ) {
    return false
  }
  const provided = Buffer.from(signature)
  const expectedBuffer = Buffer.from(sessionSignature(token, expiresAt))
  return provided.length === expectedBuffer.length && timingSafeEqual(provided, expectedBuffer)
}
