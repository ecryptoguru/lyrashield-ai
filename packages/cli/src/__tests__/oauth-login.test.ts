import { describe, expect, it } from "vitest"
import { describeOAuthFailure, validateOAuthCallback } from "../oauth-login.js"

describe("OAuth failure messages", () => {
  it("maps known failures to short controlled messages", () => {
    expect(describeOAuthFailure(new Error("Authorization was declined"))).toMatch(/declined/i)
    expect(describeOAuthFailure(new Error("Authorization timed out"))).toMatch(/timed out/i)
    expect(describeOAuthFailure(new Error("The authorized workspace could not be established"))).toMatch(
      /workspace/i
    )
  })
  it("never exposes unknown cause text", () => {
    const message = describeOAuthFailure(
      new Error('token endpoint rejected: {"error":"invalid_grant","secret":"hunter2"}')
    )
    expect(message).not.toContain("invalid_grant")
    expect(message).not.toContain("hunter2")
    expect(message).toMatch(/did not complete/)
  })
  it("handles non-Error causes with the generic message", () => {
    expect(describeOAuthFailure("boom")).toMatch(/did not complete/)
    expect(describeOAuthFailure(undefined)).toMatch(/did not complete/)
  })
})

const issuer = "https://app.lyrashieldai.com/api/auth"
function callback(query: string) {
  return new URL(`http://127.0.0.1:4567/callback?iss=${encodeURIComponent(issuer)}&${query}`)
}
describe("OAuth authorization callbacks", () => {
  it("accepts a code only for the initiated state and issuer", () => {
    expect(validateOAuthCallback(callback("state=expected&code=code"), "expected", issuer)).toBe(
      "code"
    )
  })
  it.each([
    "state=other&code=code",
    "state=expected&state=other&code=code",
    "state=expected&code=one&code=two",
    "state=expected",
    "state=expected&error=access_denied",
  ])("rejects invalid callback case %s", (query) => {
    expect(() => validateOAuthCallback(callback(query), "expected", issuer)).toThrow()
  })
  it("rejects issuer confusion and unrelated callback paths", () => {
    expect(() =>
      validateOAuthCallback(
        callback("state=expected&code=code"),
        "expected",
        "https://other.example"
      )
    ).toThrow("issuer")
    const url = callback("state=expected&code=code")
    url.pathname = "/unrelated"
    expect(() => validateOAuthCallback(url, "expected", issuer)).toThrow("state")
  })
})

// Exercise real SDK discovery, client registration, PKCE, callback, and token exchange.
import { createServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { loginWithOAuth } from "../oauth-login.js"
import { saveCredentials } from "../credentials.js"
import type { Output } from "../output.js"
import { vi } from "vitest"
vi.mock("../credentials.js", () => ({
  loadCredentials: vi.fn().mockResolvedValue({ installId: "test-install" }),
  saveCredentials: vi.fn(),
}))
it("completes the hosted OAuth flow once and saves refresh identity", async () => {
  const accessToken = randomUUID()
  const refreshToken = randomUUID()
  let base = ""
  let challenge = ""
  let exchanged = false
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json")
    if (req.url === "/api/workspaces") {
      res.end(JSON.stringify({ data: [{ id: "workspace-1" }] }))
    } else if (req.url?.includes("oauth-protected-resource")) {
      res.end(
        JSON.stringify({ resource: `${base}/api/mcp`, authorization_servers: [`${base}/api/auth`] })
      )
    } else if (req.url?.includes(".well-known")) {
      res.end(
        JSON.stringify({
          issuer: `${base}/api/auth`,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      )
    } else if (req.url === "/register") {
      let body = ""
      for await (const chunk of req) body += chunk
      res.writeHead(201).end(JSON.stringify({ ...JSON.parse(body), client_id: "test-client" }))
    } else if (req.url === "/token") {
      let body = ""
      for await (const chunk of req) body += chunk
      const input = new URLSearchParams(body)
      exchanged =
        input.get("code") === "test-code" &&
        createHash("sha256")
          .update(input.get("code_verifier") ?? "")
          .digest("base64url") === challenge
      res.end(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "lyrashield.read lyrashield.write offline_access",
        })
      )
    } else {
      res.writeHead(404).end("{}")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Test listener unavailable")
  base = `http://127.0.0.1:${address.port}`
  try {
    const output = { log: vi.fn(), error: vi.fn() } as unknown as Output
    expect(
      await loginWithOAuth(base, output, async (authorizationUrl) => {
        const url = new URL(authorizationUrl)
        challenge = url.searchParams.get("code_challenge") ?? ""
        expect(url.searchParams.get("scope")).toContain("lyrashield.write")
        const callbackUrl = new URL(url.searchParams.get("redirect_uri")!)
        callbackUrl.searchParams.set("state", url.searchParams.get("state")!)
        callbackUrl.searchParams.set("iss", `${base}/api/auth`)
        callbackUrl.searchParams.set("code", "test-code")
        expect((await fetch(callbackUrl)).status).toBe(200)
      })
    ).toBe(0)
    expect(exchanged).toBe(true)
    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        clientId: "test-client",
        issuer: `${base}/api/auth`,
        resource: `${base}/api/mcp`,
        oauthRefreshToken: refreshToken,
      })
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
