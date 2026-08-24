import { beforeEach, describe, expect, it, vi } from "vitest"

const envState = vi.hoisted(() => ({
  NODE_ENV: "production",
  LYRASHIELD_KEY_VAULT_NAME: "",
  LICENSE_SIGNING_PRIVATE_KEY: "dev-only-private-key",
  LICENSE_SIGNING_PRIVATE_KEY_SECRET_NAME: "license-signing-private-key",
  LICENSE_SIGNING_KEY_ID: "license-key-v1",
  BETTER_AUTH_URL: "https://app.lyrashieldai.com",
}))

vi.mock("@lyrashield/config", () => ({ env: envState, isDev: false }))
vi.mock("@azure/identity", () => ({ DefaultAzureCredential: class {} }))
vi.mock("@azure/keyvault-secrets", () => ({ SecretClient: class {} }))

describe("production license signing key resolution", () => {
  beforeEach(() => {
    envState.NODE_ENV = "production"
    envState.LYRASHIELD_KEY_VAULT_NAME = ""
    envState.LICENSE_SIGNING_KEY_ID = "license-key-v1"
    envState.BETTER_AUTH_URL = "https://app.lyrashieldai.com"
  })

  it("fails closed instead of using the development PEM fallback", async () => {
    const { resolveSigningPrivateKey } = await import("./license-fulfillment")

    await expect(resolveSigningPrivateKey()).rejects.toThrow("LYRASHIELD_KEY_VAULT_NAME")
  })

  it("retains the explicit local development fallback", async () => {
    envState.NODE_ENV = "development"
    const { resolveSigningPrivateKey } = await import("./license-fulfillment")

    await expect(resolveSigningPrivateKey()).resolves.toBe("dev-only-private-key")
  })

  it("allows the throwaway signing key only for the fixed loopback E2E runtime", async () => {
    envState.LICENSE_SIGNING_KEY_ID = "e2e-license-key-v1"
    envState.BETTER_AUTH_URL = "http://127.0.0.1:3100"
    const { resolveSigningPrivateKey } = await import("./license-fulfillment")

    await expect(resolveSigningPrivateKey()).resolves.toBe("dev-only-private-key")
  })
})
