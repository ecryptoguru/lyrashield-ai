import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({
  env: {
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    AZURE_AD_CLIENT_ID: "",
    AZURE_AD_CLIENT_SECRET: "",
    LYRASHIELD_REQUIRE_EMAIL_VERIFICATION: "0",
    BREVO_API_KEY: "",
  },
}))
vi.mock("@lyrashield/auth/oauth-providers", () => ({
  isOAuthProviderConfigured: (id?: string, secret?: string) => Boolean(id && secret),
}))

const { GET } = await import("./route")

describe("auth provider configuration", () => {
  it("returns configured providers and allows social registration", async () => {
    const response = await GET()

    await expect(response.json()).resolves.toMatchObject({
      github: true,
      google: false,
      microsoft: false,
      socialSignUp: true,
      emailVerification: false,
      passwordReset: false,
    })
  })
})
