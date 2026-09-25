import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const requiredProductionEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "https://app.lyrashieldai.com",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
  NODE_ENV: "production",
  TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
  LYRASHIELD_REQUIRE_EMAIL_VERIFICATION: "0",
  PLATFORM_ADMIN_EMAILS: "ecryptoguru@gmail.com,ankit@lyrashieldai.com",
} as const

describe("runtime environment validation", () => {
  beforeEach(() => {
    vi.resetModules()
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MYRA_")) vi.stubEnv(key, undefined)
    }
    for (const [key, value] of Object.entries(requiredProductionEnv)) vi.stubEnv(key, value)
    vi.stubEnv("LYRASHIELD_IMAGE", "")
    vi.stubEnv("LYRASHIELD_RUNTIME_BACKEND", "")
  })

  afterEach(() => vi.unstubAllEnvs())

  it("starts each case without inherited Myra provider settings", () => {
    expect(process.env.MYRA_GENERATION_ENABLED).toBeUndefined()
    expect(process.env.MYRA_WRITES_ENABLED).toBeUndefined()
    expect(process.env.MYRA_AZURE_OPENAI_ENDPOINT).toBeUndefined()
    expect(process.env.MYRA_AZURE_OPENAI_API_KEY).toBeUndefined()
  })

  it("allows the production web process to omit worker sandbox configuration", async () => {
    await expect(import("./env")).resolves.toBeDefined()
  })

  it("rejects Azure generation with an unapproved model", async () => {
    vi.stubEnv("MYRA_GENERATION_ENABLED", "1")
    vi.stubEnv("MYRA_PROVIDER", "azure")
    vi.stubEnv("MYRA_AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    vi.stubEnv("MYRA_AZURE_OPENAI_API_KEY", "test-key")
    vi.stubEnv("MYRA_MODEL", "gpt-5.6-luna")
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")
  })

  it("rejects Azure generation without provider credentials and deployments", async () => {
    vi.stubEnv("MYRA_GENERATION_ENABLED", "1")
    vi.stubEnv("MYRA_PROVIDER", "azure")
    vi.stubEnv("MYRA_MODEL", "gpt-6-luna")
    vi.stubEnv("MYRA_AZURE_OPENAI_ENDPOINT", "")
    vi.stubEnv("MYRA_AZURE_OPENAI_API_KEY", "")
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")
  })

  it("rejects a missing or expanded production platform-admin allowlist", async () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "")
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")

    vi.resetModules()
    vi.stubEnv(
      "PLATFORM_ADMIN_EMAILS",
      "ecryptoguru@gmail.com,ankit@lyrashieldai.com,extra@lyrashieldai.com"
    )
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")
  })

  it("rejects an http egress proxy URL in production (bearer-token cleartext transport)", async () => {
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_URL", "http://proxy.internal:8080")
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_SECRET", "test-proxy-secret")
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")
  })

  it("accepts an https egress proxy URL in production", async () => {
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_URL", "https://proxy.internal:8443")
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_SECRET", "test-proxy-secret")
    await expect(import("./env")).resolves.toBeDefined()
  })

  it("rejects an incomplete egress proxy credential pair", async () => {
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_URL", "https://proxy.internal:8443")
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_SECRET", "")
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")
  })

  it("accepts an http egress proxy URL outside production", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_URL", "http://localhost:8080")
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_SECRET", "test-proxy-secret")
    await expect(import("./env")).resolves.toBeDefined()
  })

  it("keeps relay grants off cleartext remote transport in every environment", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("LYRASHIELD_TARGET_RELAY_URL", "http://relay.example:8080")
    vi.stubEnv("LYRASHIELD_RELAY_SIGNING_SECRET", "test-signing-secret")
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")

    vi.resetModules()
    vi.stubEnv("LYRASHIELD_TARGET_RELAY_URL", "http://127.0.0.1:8080")
    await expect(import("./env")).resolves.toBeDefined()

    vi.resetModules()
    vi.stubEnv("LYRASHIELD_TARGET_RELAY_URL", "http://[::1]:8080/")
    await expect(import("./env")).resolves.toBeDefined()

    // A loopback-looking authority that is actually a remote host must fail.
    vi.resetModules()
    vi.stubEnv("LYRASHIELD_TARGET_RELAY_URL", "http://127.0.0.1.evil.example")
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")

    vi.resetModules()
    vi.stubEnv("LYRASHIELD_TARGET_RELAY_URL", "http://user@127.0.0.1:8080")
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")
  })

  // VULN-I-001: secureCookies derives the session Secure flag from the
  // BETTER_AUTH_URL scheme — an http:// production origin ships cookies
  // transmittable in cleartext.
  it("rejects a non-loopback http BETTER_AUTH_URL in production", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://app.lyrashieldai.com")
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")
  })

  it("accepts https and loopback-http BETTER_AUTH_URL in production", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.lyrashieldai.com")
    await expect(import("./env")).resolves.toBeDefined()

    vi.resetModules()
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3100")
    await expect(import("./env")).resolves.toBeDefined()
  })
})
