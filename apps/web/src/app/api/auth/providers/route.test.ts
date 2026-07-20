import { describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({
  isProd: true,
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
  socialSignUpEnabled: () => false,
}))

const { GET } = await import("./route")

describe("auth provider configuration", () => {
  it("keeps the initial beta independent of Brevo", async () => {
    const response = await GET()

    await expect(response.json()).resolves.toMatchObject({
      github: true,
      google: false,
      microsoft: false,
      socialSignUp: false,
      emailVerification: false,
      passwordReset: false,
    })
  })
})
