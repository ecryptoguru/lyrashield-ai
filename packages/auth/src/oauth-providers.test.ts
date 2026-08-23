import { describe, expect, it } from "vitest"
import { microsoft } from "better-auth/social-providers"
import { buildMicrosoftSocialProvider, isOAuthProviderConfigured } from "./oauth-providers"

describe("OAuth provider configuration", () => {
  it("requires both a nonblank client ID and secret", () => {
    expect(isOAuthProviderConfigured("client-id", "client-secret")).toBe(true)
    expect(isOAuthProviderConfigured("client-id", undefined)).toBe(false)
    expect(isOAuthProviderConfigured(undefined, "client-secret")).toBe(false)
    expect(isOAuthProviderConfigured(" ", "client-secret")).toBe(false)
  })

  it("uses the built-in Microsoft social-provider configuration for multi-tenant auth", () => {
    const provider = buildMicrosoftSocialProvider("client-id", "client-secret", "common")
    expect(provider).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      tenantId: "common",
      enabled: true,
      disableSignUp: false,
    })
    expect(() => microsoft(provider)).not.toThrow()
    expect(buildMicrosoftSocialProvider(undefined, undefined, undefined)).toMatchObject({
      tenantId: "common",
      enabled: false,
    })
  })
})
