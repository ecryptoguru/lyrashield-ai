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
})
