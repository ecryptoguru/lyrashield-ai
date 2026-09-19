import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { AuthSessionError, resolveRelaySessionBinding } from "./auth-session"

const baseAuthorization = {
  approvedHost: "staging.example.com",
  credentialId: "cred-1",
  credentialKind: "BEARER_TOKEN",
  credentialVaultRef: "env:LYRASHIELD_TEST_SESSION_ACME",
  credentialScope: null,
  credentialExpiresAt: new Date("2026-09-19T13:00:00.000Z"),
}

const options = {
  grantExpiresAtMs: new Date("2026-09-19T12:15:00.000Z").getTime(),
  runtimeEnv: {
    LYRASHIELD_TEST_SESSION_ACME: "test-session-material",
  } as NodeJS.ProcessEnv,
}

describe("resolveRelaySessionBinding", () => {
  it("resolves a bearer test session bounded to the approved host", () => {
    const binding = resolveRelaySessionBinding(baseAuthorization, options)
    expect(binding.headers).toEqual({ authorization: "Bearer test-session-material" })
    expect(binding.hosts).toEqual(["staging.example.com"])
    // Session expiry is the earlier of the credential expiry and the grant.
    expect(binding.exp).toBe(options.grantExpiresAtMs)
  })

  it("binds the session to the credential expiry when it is sooner", () => {
    const binding = resolveRelaySessionBinding(baseAuthorization, {
      ...options,
      grantExpiresAtMs: new Date("2026-09-19T14:00:00.000Z").getTime(),
    })
    expect(binding.exp).toBe(baseAuthorization.credentialExpiresAt.getTime())
  })

  it("maps a session cookie kind onto the cookie header", () => {
    const binding = resolveRelaySessionBinding(
      { ...baseAuthorization, credentialKind: "SESSION_COOKIE" },
      options
    )
    expect(binding.headers).toEqual({ cookie: "test-session-material" })
    expect(JSON.stringify(binding.headers)).not.toContain("Bearer")
  })

  it("maps a HEADER kind onto the scoped injectable header", () => {
    const binding = resolveRelaySessionBinding(
      {
        ...baseAuthorization,
        credentialKind: "HEADER",
        credentialScope: { headerName: "X-Session-Token" },
      },
      options
    )
    expect(binding.headers).toEqual({ "x-session-token": "test-session-material" })
  })

  it("rejects vault references outside the test-session env contract", () => {
    for (const credentialVaultRef of [
      "DATABASE_URL",
      "env:DATABASE_URL",
      "env:LYRASHIELD_SESSION_PROD",
      "kv:prod-secret",
      "env:lyrashield_test_session_lower",
      "vault://prod/creds",
    ]) {
      expect(() =>
        resolveRelaySessionBinding({ ...baseAuthorization, credentialVaultRef }, options)
      ).toThrowError(AuthSessionError)
    }
  })

  it("rejects when the referenced material is missing or malformed", () => {
    expect(() =>
      resolveRelaySessionBinding(baseAuthorization, {
        ...options,
        runtimeEnv: {} as NodeJS.ProcessEnv,
      })
    ).toThrowError(expect.objectContaining({ code: "AUTH_SESSION_UNAVAILABLE" }))
    expect(() =>
      resolveRelaySessionBinding(baseAuthorization, {
        ...options,
        runtimeEnv: {
          LYRASHIELD_TEST_SESSION_ACME: "line1\r\ninjected: yes",
        } as NodeJS.ProcessEnv,
      })
    ).toThrowError(expect.objectContaining({ code: "AUTH_SESSION_MATERIAL_INVALID" }))
  })

  it("rejects non-allowlisted header names and unmodeled credential kinds", () => {
    expect(() =>
      resolveRelaySessionBinding(
        {
          ...baseAuthorization,
          credentialKind: "HEADER",
          credentialScope: { headerName: "x-forwarded-for" },
        },
        options
      )
    ).toThrowError(expect.objectContaining({ code: "AUTH_SESSION_HEADER_UNSUPPORTED" }))
    expect(() =>
      resolveRelaySessionBinding(
        { ...baseAuthorization, credentialKind: "PROD_API_KEY" },
        options
      )
    ).toThrowError(expect.objectContaining({ code: "AUTH_SESSION_KIND_UNSUPPORTED" }))
  })

  it("narrows injection to credential-scoped hosts", () => {
    const binding = resolveRelaySessionBinding(
      {
        ...baseAuthorization,
        credentialScope: { hosts: ["api.staging.example.com"] },
      },
      options
    )
    expect(binding.hosts).toEqual(["api.staging.example.com"])
  })

  it("never places session material in the logged metadata", async () => {
    const { logger } = await import("@lyrashield/logger")
    resolveRelaySessionBinding(baseAuthorization, options)
    const calls = JSON.stringify(vi.mocked(logger.info).mock.calls)
    expect(calls).not.toContain("test-session-material")
  })
})
