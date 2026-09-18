/**
 * Contract for the allowlisted public CORS surface (audit finding: the public
 * Myra rollout).
 *
 * The marketing Myra flows (session mint, demo slots, identity codes) call
 * `app.lyrashieldai.com` with `credentials: "include"`. A browser rejects a
 * credentialed cross-origin response that omits
 * `Access-Control-Allow-Credentials: true`, which surfaced as an opaque
 * "Failed to fetch" on /demo and in the support panel — the endpoint itself
 * never ran. These tests pin the header and the allowlist behaviour.
 */
import { afterEach, describe, expect, it } from "vitest"
import { isPublicOriginAllowed, publicCorsHeaders, publicPreflight } from "./public-cors"

const MARKETING = "https://lyrashieldai.com"
const APP = "https://app.lyrashieldai.com"

function withOrigins<T>(fn: () => T): T {
  const before = {
    marketing: process.env.NEXT_PUBLIC_MARKETING_URL,
    app: process.env.NEXT_PUBLIC_APP_URL,
  }
  process.env.NEXT_PUBLIC_MARKETING_URL = MARKETING
  process.env.NEXT_PUBLIC_APP_URL = APP
  try {
    return fn()
  } finally {
    if (before.marketing === undefined) delete process.env.NEXT_PUBLIC_MARKETING_URL
    else process.env.NEXT_PUBLIC_MARKETING_URL = before.marketing
    if (before.app === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = before.app
  }
}

const request = (origin?: string, method = "POST") =>
  new Request("https://app.lyrashieldai.com/api/myra/session", {
    method,
    headers: origin ? { origin } : {},
  })

afterEach(() => {
  delete process.env.NEXT_PUBLIC_MARKETING_URL
  delete process.env.NEXT_PUBLIC_APP_URL
})

describe("publicCorsHeaders", () => {
  it("allows credentialed requests from an allowlisted origin", () => {
    withOrigins(() => {
      const headers = publicCorsHeaders(request(MARKETING))
      expect(headers["Access-Control-Allow-Origin"]).toBe(MARKETING)
      expect(headers["Access-Control-Allow-Credentials"]).toBe("true")
      expect(headers["Vary"]).toBe("Origin")
    })
  })

  it("never reflects an origin outside the allowlist", () => {
    withOrigins(() => {
      expect(publicCorsHeaders(request("https://evil.example"))).toEqual({})
      expect(publicCorsHeaders(request())).toEqual({})
    })
  })
})

describe("isPublicOriginAllowed", () => {
  it("accepts only the configured marketing and app origins", () => {
    withOrigins(() => {
      expect(isPublicOriginAllowed(request(MARKETING))).toBe(true)
      expect(isPublicOriginAllowed(request(APP))).toBe(true)
      expect(isPublicOriginAllowed(request("https://evil.example"))).toBe(false)
      expect(isPublicOriginAllowed(request())).toBe(false)
    })
  })
})

describe("publicPreflight", () => {
  it("answers an allowlisted preflight with credentials allowed", () => {
    withOrigins(() => {
      const response = publicPreflight(request(MARKETING, "OPTIONS"))
      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe(MARKETING)
      expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    })
  })

  it("refuses a preflight from an unknown origin", () => {
    withOrigins(() => {
      const response = publicPreflight(request("https://evil.example", "OPTIONS"))
      expect(response.status).toBe(403)
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
    })
  })
})
