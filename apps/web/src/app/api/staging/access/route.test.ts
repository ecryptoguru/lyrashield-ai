import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ restricted: true, tokenValid: true }))

vi.mock("@/lib/billing-staging-access", () => ({
  BILLING_STAGING_ACCESS_COOKIE: "__Host-lyrashield-billing-staging",
  BILLING_STAGING_ACCESS_MAX_AGE_SECONDS: 28_800,
  createBillingStagingAccessCookieValue: () => "opaque-cookie-value",
  isRestrictedBillingStaging: () => state.restricted,
  isValidBillingStagingToken: () => state.tokenValid,
}))

import { POST } from "./route"

function request(
  origin = "https://stage.example",
  url = "https://stage.example/api/staging/access"
) {
  const body = new FormData()
  body.set("token", "secret-access-code")
  return new Request(url, {
    method: "POST",
    headers: { origin },
    body,
  })
}

describe("POST /api/staging/access", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://stage.example")
    state.restricted = true
    state.tokenValid = true
  })

  it("sets only a secure same-origin HttpOnly session cookie", async () => {
    const response = await POST(request())
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("https://stage.example/sign-up")
    const cookie = response.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("__Host-lyrashield-billing-staging=opaque-cookie-value")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=lax")
    expect(cookie).toContain("Path=/")
    expect(cookie).not.toContain("secret-access-code")
  })

  it("redirects to the configured public origin behind a reverse proxy", async () => {
    const response = await POST(
      request("https://stage.example", "https://0.0.0.0:3000/api/staging/access")
    )
    expect(response.headers.get("location")).toBe("https://stage.example/sign-up")
  })

  it("rejects cross-origin, invalid, and non-staging requests", async () => {
    expect((await POST(request("https://attacker.example"))).status).toBe(403)
    state.tokenValid = false
    expect((await POST(request())).status).toBe(403)
    state.restricted = false
    expect((await POST(request())).status).toBe(404)
  })
})
