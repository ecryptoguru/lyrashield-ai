import { describe, expect, it } from "vitest"
import { normalizeLoopbackOAuthClient } from "./oauth-registration"

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
})
