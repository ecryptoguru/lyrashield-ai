import { createHmac, randomBytes, timingSafeEqual } from "crypto"
import { env } from "@lyrashield/config"

/**
 * Signed, expiring consent-context token for delegated OAuth connections.
 *
 * `POST /api/connections` must not trust a client-supplied `oauthClientId` or
 * scope list: the connection grant has to describe the same client and scopes
 * as the server-driven OAuth authorization request the user is consenting to.
 * The consent page (a server component rendering the live authorization
 * request) issues this state; the connections route verifies it before
 * persisting anything and before `pendingAgentConnectionId` is set.
 *
 * Format: base64url(JSON payload) + "." + base64url(hmac)
 * where payload = { clientId, scopes, userId, nonce, exp }.
 */

const TTL_MS = 15 * 60 * 1000 // 15 minutes — one consent interaction

export const OAUTH_CONNECTION_SCOPES = ["lyrashield.read", "lyrashield.write"] as const

export interface OAuthConsentStatePayload {
  clientId: string
  scopes: string[]
  userId: string
  nonce: string
  exp: number
}

function sign(payload: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url")
}

export function createOAuthConsentState(
  input: { clientId: string; scopes: string[]; userId: string },
  now: number = Date.now()
): string {
  const payload: OAuthConsentStatePayload = {
    clientId: input.clientId,
    scopes: [...new Set(input.scopes)],
    userId: input.userId,
    nonce: randomBytes(12).toString("base64url"),
    exp: now + TTL_MS,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${encoded}.${sign(encoded)}`
}

export type OAuthConsentStateResult =
  | { valid: true; payload: OAuthConsentStatePayload }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" }

export function verifyOAuthConsentState(
  state: string,
  now: number = Date.now()
): OAuthConsentStateResult {
  const parts = state.split(".")
  if (parts.length !== 2) return { valid: false, reason: "malformed" }
  const [encoded, sig] = parts as [string, string]
  if (!encoded || !sig) return { valid: false, reason: "malformed" }

  const expected = sign(encoded)
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: "bad_signature" }
  }

  let payload: OAuthConsentStatePayload
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, reason: "malformed" }
    }
    const candidate = parsed as Record<string, unknown>
    if (
      typeof candidate.clientId !== "string" ||
      !candidate.clientId ||
      !Array.isArray(candidate.scopes) ||
      !candidate.scopes.every((scope) => typeof scope === "string") ||
      typeof candidate.userId !== "string" ||
      !candidate.userId ||
      typeof candidate.nonce !== "string" ||
      typeof candidate.exp !== "number"
    ) {
      return { valid: false, reason: "malformed" }
    }
    payload = candidate as unknown as OAuthConsentStatePayload
  } catch {
    return { valid: false, reason: "malformed" }
  }

  if (!Number.isFinite(payload.exp) || now > payload.exp) {
    return { valid: false, reason: "expired" }
  }

  return { valid: true, payload }
}

/**
 * Whether the connection grant requested by the consent form matches the
 * authorization request bound in the consent state: the OAuth client must be
 * the same, and every granted scope must have been requested. A read-only
 * authorization request can never mint a write connection.
 */
export function connectionGrantMatchesConsent(
  verified: OAuthConsentStatePayload,
  requested: { oauthClientId: string; scopes: string[] }
): boolean {
  if (verified.clientId !== requested.oauthClientId) return false
  return requested.scopes.every((scope) => verified.scopes.includes(scope))
}
