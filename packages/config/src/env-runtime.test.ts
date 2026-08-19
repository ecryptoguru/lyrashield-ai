import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const requiredProductionEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "https://app.lyrashieldai.com",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
  NODE_ENV: "production",
  TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
  LYRASHIELD_REQUIRE_EMAIL_VERIFICATION: "0",
} as const

describe("runtime environment validation", () => {
  beforeEach(() => {
    vi.resetModules()
    for (const [key, value] of Object.entries(requiredProductionEnv)) vi.stubEnv(key, value)
    vi.stubEnv("LYRASHIELD_IMAGE", "")
    vi.stubEnv("LYRASHIELD_RUNTIME_BACKEND", "")
  })

  afterEach(() => vi.unstubAllEnvs())

  it("allows the production web process to omit worker sandbox configuration", async () => {
    await expect(import("./env")).resolves.toBeDefined()
  })

  it("rejects an http egress proxy URL in production (bearer-token cleartext transport)", async () => {
    // The env loader logs "Invalid environment variables" to console.error
    // before throwing — that's expected output for this negative test, not a
    // real failure. Silence it so the CI log isn't polluted with a misleading
    // error message (the assertion below is what actually verifies the rule).
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_URL", "http://proxy.internal:8080")
    await expect(import("./env")).rejects.toThrow("Invalid environment configuration")
    consoleError.mockRestore()
  })

  it("accepts an https egress proxy URL in production", async () => {
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_URL", "https://proxy.internal:8443")
    await expect(import("./env")).resolves.toBeDefined()
  })

  it("accepts an http egress proxy URL outside production", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("LYRASHIELD_EGRESS_PROXY_URL", "http://localhost:8080")
    await expect(import("./env")).resolves.toBeDefined()
  })
})
