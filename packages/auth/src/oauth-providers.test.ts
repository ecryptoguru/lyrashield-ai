import { describe, expect, it } from "vitest"
import { isOAuthProviderConfigured } from "./oauth-providers"

describe("OAuth provider configuration", () => {
  it("requires both a nonblank client ID and secret", () => {
    expect(isOAuthProviderConfigured("client-id", "client-secret")).toBe(true)
    expect(isOAuthProviderConfigured("client-id", undefined)).toBe(false)
    expect(isOAuthProviderConfigured(undefined, "client-secret")).toBe(false)
    expect(isOAuthProviderConfigured(" ", "client-secret")).toBe(false)
  })
})
