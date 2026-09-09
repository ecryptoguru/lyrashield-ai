import { createHmac, randomBytes, timingSafeEqual } from "crypto"
import { env } from "@lyrashield/config"

/**
 * W2-05: signed, expiring return state for agent-first onboarding.
 *
 * A user arriving from an OAuth client (for example a coding agent) who has no
 * workspace yet must finish identity/workspace setup before they can consent.
 * The consent page hands the onboarding wizard a signed blob describing the
 * exact authorization request; when onboarding completes, the wizard returns
 * the user to `/oauth/consent` with that query — never to an arbitrary URL.
 *
 * Threat model: the state is HMAC-signed (tamper-evident), time-limited, and
 * bound to the user who was sent to onboarding. The return destination is a
 * fixed route, so even a stolen state cannot produce an open redirect. No
 * workspace grant travels inside the state: the consent page re-reads
 * memberships fresh at consent time, so revocation between onboarding and
 * consent is enforced by the normal membership check, not by this token.
 */

const TTL_MS = 15 * 60 * 1000 // 15 minutes

function sign(payload: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url")
}

export function createOAuthOnboardingReturn(
  oauthQuery: string,
  userId: string,
  now: number = Date.now()
): string {
  const nonce = Buffer.from(new Date().toISOString()).toString("base64url")
  const payload = `${Buffer.from(oauthQuery).toString("base64url")}.${Buffer.from(userId).toString("base64url")}.${nonce}.${now + TTL_MS}`
  return `${payload}.${sign(payload)}`
}

export type OAuthOnboardingReturnResult =
  | { valid: true; oauthQuery: string; userId: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" }

export function verifyOAuthOnboardingReturn(
  state: string,
  now: number = Date.now()
): OAuthOnboardingReturnResult {
  const parts = state.split(".")
  if (parts.length !== 5) return { valid: false, reason: "malformed" }
  const [queryB64, userB64, nonce, expStr, sig] = parts
  if (!queryB64 || !userB64 || !nonce || !expStr || !sig) {
    return { valid: false, reason: "malformed" }
  }

  const payload = `${queryB64}.${userB64}.${nonce}.${expStr}`
  const expected = sign(payload)
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: "bad_signature" }
  }

  const expMs = Number(expStr)
  if (!Number.isFinite(expMs) || now > expMs) {
    return { valid: false, reason: "expired" }
  }

  let oauthQuery: string
  let userId: string
  try {
    oauthQuery = Buffer.from(queryB64, "base64url").toString("utf-8")
    userId = Buffer.from(userB64, "base64url").toString("utf-8")
  } catch {
    return { valid: false, reason: "malformed" }
  }
  if (!oauthQuery || !userId) return { valid: false, reason: "malformed" }

  return { valid: true, oauthQuery, userId }
}
