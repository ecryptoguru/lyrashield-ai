import { afterEach, describe, expect, it, vi } from "vitest"
import { verifyRelayGrant } from "@lyrashield/security"
import { mintScanRelayGrant, registerRelayGrant, resolveRelayRuntimeConfig } from "./relay-client"

const CONFIG = {
  url: "http://relay.test",
  signingSecret: "test-signing-secret",
  adminSecret: "test-admin-secret",
}

const baseInput = {
  scanId: "scan-1",
  mode: "STANDARD" as const,
  verifiedDomain: "example.com",
  targetUrl: "https://app.example.com/login",
  engineBudgetMs: 12 * 60 * 1000,
}

describe("resolveRelayRuntimeConfig", () => {
  it("returns null when any component is missing", () => {
    expect(resolveRelayRuntimeConfig({ LYRASHIELD_TARGET_RELAY_URL: "http://r" })).toBeNull()
    expect(resolveRelayRuntimeConfig({})).toBeNull()
  })

  it("requires url + signing secret + admin secret", () => {
    expect(
      resolveRelayRuntimeConfig({
        LYRASHIELD_TARGET_RELAY_URL: "http://relay.test/",
        LYRASHIELD_RELAY_SIGNING_SECRET: "s",
        LYRASHIELD_EGRESS_PROXY_SECRET: "e",
      })
    ).toEqual({ url: "http://relay.test", signingSecret: "s", adminSecret: "e" })
  })
})

describe("mintScanRelayGrant", () => {
  it("scopes hosts to the verified domain, target host, spec URL, and spec servers", () => {
    const { grant, scope } = mintScanRelayGrant(
      {
        ...baseInput,
        apiSpecUrl: "https://api.example.com/openapi.json",
        specServerHosts: ["api.example.com", "staging-api.example.com"],
      },
      CONFIG
    )
    expect(scope.hosts.sort()).toEqual([
      "api.example.com",
      "app.example.com",
      "example.com",
      "staging-api.example.com",
    ])
    // The minted token verifies with the same secret.
    expect(verifyRelayGrant(grant, CONFIG.signingSecret)).toEqual({ ok: true, scope })
  })

  it("keeps destructive methods out unless the policy allows them", () => {
    const safe = mintScanRelayGrant(baseInput, CONFIG)
    expect(safe.scope.methods).toEqual(["GET", "HEAD", "OPTIONS", "POST"])

    const destructive = mintScanRelayGrant({ ...baseInput, destructiveTestsAllowed: true }, CONFIG)
    expect(destructive.scope.methods).toEqual([
      "GET",
      "HEAD",
      "OPTIONS",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ])
  })

  it("narrows hosts to the policy allowlist and never widens it", () => {
    const { scope } = mintScanRelayGrant(
      {
        ...baseInput,
        apiSpecUrl: "https://api.other-host.com/openapi.json",
        allowedDomains: ["example.com"],
      },
      CONFIG
    )
    expect(scope.hosts).not.toContain("api.other-host.com")
    expect(scope.hosts).toContain("example.com")
  })

  it("fails when the allowlist narrows scope to nothing", () => {
    expect(() =>
      mintScanRelayGrant({ ...baseInput, allowedDomains: ["elsewhere.com"] }, CONFIG)
    ).toThrow("RELAY_SCOPE_EMPTY")
  })

  it("bounds the grant by the engine budget plus grace", () => {
    const before = Date.now()
    const { scope } = mintScanRelayGrant(baseInput, CONFIG)
    const expected = before + 12 * 60 * 1000 + 5 * 60 * 1000
    expect(scope.exp).toBeGreaterThanOrEqual(expected)
    expect(scope.exp).toBeLessThan(expected + 5_000)
  })

  it("scales request budgets with the engine depth", () => {
    const standard = mintScanRelayGrant(baseInput, CONFIG)
    expect(standard.scope.maxRequests).toBe(800)
    const deep = mintScanRelayGrant(
      { ...baseInput, mode: "DEEP" as const, engineBudgetMs: 40 * 60 * 1000 },
      CONFIG
    )
    expect(deep.scope.maxRequests).toBe(2_500)
    expect(deep.scope.ratePerMinute).toBe(240)
  })

  it("never scopes hosts outside the verified apex — spec servers included", () => {
    const { scope } = mintScanRelayGrant(
      {
        ...baseInput,
        targetUrl: "https://unrelated-host.net/app",
        apiSpecUrl: "https://api.third-party.io/openapi.json",
        specServerHosts: ["api.third-party.io", "api.example.com"],
      },
      CONFIG
    )
    // Verified apex keeps its subdomain scope; out-of-apex references are dropped.
    expect(scope.hosts.sort()).toEqual(["api.example.com", "example.com"])
  })
})

describe("registerRelayGrant", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("registers the exact grant with admin authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    await registerRelayGrant("scan-1", "signed-grant", CONFIG)
    expect(fetchMock).toHaveBeenCalledWith(
      "http://relay.test/v1/register/scan-1",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Bearer test-admin-secret",
          "x-lyra-relay-grant": "signed-grant",
        },
      })
    )
  })

  it.each([Response.json({ ok: false }), Response.json({ ok: true }, { status: 403 })])(
    "fails closed without automatic registration retry",
    async (response) => {
      const fetchMock = vi.fn().mockResolvedValue(response)
      vi.stubGlobal("fetch", fetchMock)
      await expect(registerRelayGrant("scan-1", "signed-grant", CONFIG)).rejects.toThrow(
        "RELAY_REGISTRATION_FAILED"
      )
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )
})
