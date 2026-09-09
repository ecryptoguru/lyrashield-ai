import { describe, expect, it } from "vitest"
import {
  normalizeLoopbackOAuthClient,
  normalizeOAuthRateLimitResponse,
  OAUTH_RATE_LIMIT_ERROR,
} from "./oauth-registration"

describe("normalizeLoopbackOAuthClient", () => {
  it("classifies a desktop loopback registration as native", () => {
    expect(
      normalizeLoopbackOAuthClient({
        application_type: "web",
        redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
        client_name: "OpenCode",
        token_endpoint_auth_method: "none",
      })
    ).toEqual({
      application_type: "native",
      redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
      client_name: "OpenCode",
      token_endpoint_auth_method: "none",
    })
  })

  it("classifies OpenCode's public loopback registration as native when application_type is omitted", () => {
    expect(
      normalizeLoopbackOAuthClient({
        redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
        client_name: "OpenCode",
        client_uri: "https://opencode.ai",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      })
    ).toMatchObject({
      application_type: "native",
      token_endpoint_auth_method: "none",
    })
  })

  it.each([
    ["https web client", ["https://client.example/callback"]],
    ["non-loopback HTTP client", ["http://client.example/callback"]],
    ["mixed callbacks", ["http://127.0.0.1:19876/callback", "https://client.example/callback"]],
  ])("does not reclassify %s", (_case, redirect_uris) => {
    const input = { application_type: "web", redirect_uris }
    expect(normalizeLoopbackOAuthClient(input)).toBe(input)
  })

  it("does not reclassify a confidential web client", () => {
    const input = {
      application_type: "web",
      redirect_uris: ["http://127.0.0.1:19876/callback"],
      token_endpoint_auth_method: "client_secret_basic",
    }
    expect(normalizeLoopbackOAuthClient(input)).toBe(input)
  })

  it("does not reclassify a client that omits its token authentication method", () => {
    const input = {
      application_type: "web",
      redirect_uris: ["http://127.0.0.1:19876/callback"],
    }
    expect(normalizeLoopbackOAuthClient(input)).toBe(input)
  })

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
