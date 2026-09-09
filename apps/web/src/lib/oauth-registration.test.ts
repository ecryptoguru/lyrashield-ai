import { describe, expect, it } from "vitest"
import { normalizeOAuthRateLimitResponse, OAUTH_RATE_LIMIT_ERROR } from "./oauth-registration"

describe("OAuth response compatibility", () => {
  it("returns OAuth-standard rate-limit errors while preserving retry metadata", async () => {
    const response = await normalizeOAuthRateLimitResponse(
      new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), {
        status: 429,
        headers: { "Retry-After": "60" },
      })
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
    await expect(response.json()).resolves.toEqual(OAUTH_RATE_LIMIT_ERROR)
  })

  it("leaves non-rate-limited OAuth responses unchanged", async () => {
    const response = new Response(null, { status: 204 })
    await expect(normalizeOAuthRateLimitResponse(response)).resolves.toBe(response)
  })
})
