/**
 * First-party attribution cookie helper.
 *
 * The `__ls_aff` cookie is a RANDOM TOKEN ID (opaque), NOT a JWT. The server
 * looks up the token hash in the AttributionToken table to resolve the
 * affiliate. This prevents tampering — the cookie carries no claimable data.
 *
 * Cookie attributes:
 *  - Max-Age = 5184000 (60 days)
 *  - Path = /
 *  - Secure
 *  - HttpOnly
 *  - SameSite = Lax
 *  - Domain = .lyrashieldai.com (configurable via env)
 *
 * Consent-gated: only set when the visitor has consented to non-essential
 * cookies. The caller is responsible for checking consent state.
 */

import { env } from "@lyrashield/config"

export const AFFILIATE_COOKIE_MAX_AGE = 5_184_000 // 60 days in seconds

export interface AffiliateCookieOptions {
  /** Override the cookie domain (defaults to env AFFILIATE_COOKIE_DOMAIN). */
  domain?: string
  /** Override max-age in seconds (defaults to 60 days). */
  maxAge?: number
  /** Whether the request is HTTPS (defaults to true for production). */
  secure?: boolean
}

/**
 * Build the Set-Cookie string for the attribution token.
 * The token value is a random opaque id — the server does a DB lookup.
 */
export function buildAffiliateCookie(token: string, options: AffiliateCookieOptions = {}): string {
  const domain = options.domain ?? env.AFFILIATE_COOKIE_DOMAIN ?? ".lyrashieldai.com"
  const maxAge = options.maxAge ?? AFFILIATE_COOKIE_MAX_AGE
  const secure = options.secure ?? env.NODE_ENV === "production"

  const parts = [
    `${"__ls_aff"}=${encodeURIComponent(token)}`,
    `Max-Age=${maxAge}`,
    `Path=/`,
    `Domain=${domain}`,
    `SameSite=Lax`,
    `HttpOnly`,
  ]

  if (secure) {
    parts.push("Secure")
  }

  return parts.join("; ")
}

/**
 * Parse the attribution cookie value from a Cookie header.
 * Returns the opaque token string, or null if not present.
 */
export function parseAffiliateCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null

  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=")
    if (name === "__ls_aff") {
      const value = valueParts.join("=")
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
  }

  return null
}
