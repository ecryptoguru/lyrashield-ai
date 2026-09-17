/**
 * Myra calendar production fail-closed rules (Deep Review v18 item 1.4).
 *
 * Production must never accept the mock calendar for real bookings and must
 * never run the mock fault-injection switches. These tests stub every MYRA_*
 * variable the schema consults so ambient developer .env values cannot leak
 * into the assertions. `loadEnv` reports issues through console.error and
 * throws a generic Error, so each rejection also asserts the printed issue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const requiredProductionEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@db.example.com:5432/app",
  BETTER_AUTH_SECRET: "s".repeat(32),
  BETTER_AUTH_URL: "https://app.example.com",
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  TRUSTED_PROXY_IP_HEADER: "cf-connecting-ip",
  PLATFORM_ADMIN_EMAILS: "ecryptoguru@gmail.com,ankit@lyrashieldai.com",
  BREVO_API_KEY: "x",
  ADMIN_ALERT_EMAIL: "alerts@lyrashieldai.com",
  REDIS_URL: "redis://localhost:6379",
}

// Complete neutral Myra baseline — stubbed explicitly so a developer's real
// MYRA_* .env values (Azure endpoints, writes flags) cannot flip a case.
const myraBaseEnv = {
  MYRA_PUBLIC_ENABLED: "0",
  MYRA_DASHBOARD_ENABLED: "0",
  MYRA_GENERATION_ENABLED: "0",
  MYRA_WRITES_ENABLED: "0",
  MYRA_OPERATOR_ENABLED: "0",
  MYRA_CALENDAR_PROVIDER: "mock",
  MYRA_PROVIDER: "mock",
  MYRA_AZURE_OPENAI_ENDPOINT: "",
  MYRA_AZURE_OPENAI_API_KEY: "",
  MYRA_AZURE_OPENAI_DEPLOYMENT: "",
  MYRA_MODEL_FAST: "",
  MYRA_MODEL_DEEP: "",
  MYRA_EMBED_MODEL: "",
  MYRA_MONTHLY_BUDGET_USD: "",
  MYRA_COST_PER_1K_INPUT_USD: "",
  MYRA_COST_PER_1K_OUTPUT_USD: "",
  MYRA_DEEP_COST_PER_1K_INPUT_USD: "",
  MYRA_DEEP_COST_PER_1K_OUTPUT_USD: "",
  MYRA_MOCK_CALENDAR_TIMEOUT_ON_INSERT: "0",
  MYRA_MOCK_CALENDAR_PENDING_CONFERENCE: "0",
  MYRA_MOCK_CALENDAR_EXTERNAL_CONFLICT: "0",
  MYRA_GOOGLE_CLIENT_ID: "",
  MYRA_GOOGLE_CLIENT_SECRET: "",
  MYRA_GOOGLE_REFRESH_TOKEN: "",
  MYRA_GOOGLE_TOKEN_JSON: "",
  MYRA_GOOGLE_CALENDAR_ID: "",
  MYRA_SUPPORT_NOTIFY_EMAIL: "",
}

const googleWriteEnv = {
  MYRA_WRITES_ENABLED: "1",
  MYRA_CALENDAR_PROVIDER: "google",
  MYRA_GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  MYRA_GOOGLE_CLIENT_SECRET: "secret",
  MYRA_GOOGLE_REFRESH_TOKEN: "refresh-token",
}

let consoleSpy: ReturnType<typeof vi.spyOn>

async function importEnv(overrides: Record<string, string> = {}) {
  vi.resetModules()
  for (const [key, value] of Object.entries({
    ...requiredProductionEnv,
    ...myraBaseEnv,
    ...overrides,
  })) {
    vi.stubEnv(key, value)
  }
  return import("./env")
}

async function expectRejectedFor(variable: string, overrides: Record<string, string> = {}) {
  await expect(importEnv(overrides)).rejects.toThrow("Invalid environment configuration")
  const printed = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n")
  expect(printed).toContain(variable)
}

beforeEach(() => {
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("Myra production calendar guards", () => {
  it("rejects the mock calendar provider in production when writes are enabled", async () => {
    await expectRejectedFor("MYRA_CALENDAR_PROVIDER", { MYRA_WRITES_ENABLED: "1" })
  })

  it("rejects the mock calendar provider even when Google credentials exist", async () => {
    await expectRejectedFor("MYRA_CALENDAR_PROVIDER", {
      MYRA_WRITES_ENABLED: "1",
      MYRA_GOOGLE_CLIENT_ID: "client-id",
      MYRA_GOOGLE_CLIENT_SECRET: "secret",
      MYRA_GOOGLE_REFRESH_TOKEN: "refresh",
    })
  })

  it("requires Google client credentials when writes are enabled", async () => {
    await expectRejectedFor("MYRA_GOOGLE_CLIENT_ID", {
      MYRA_WRITES_ENABLED: "1",
      MYRA_CALENDAR_PROVIDER: "google",
    })
    await expectRejectedFor("MYRA_GOOGLE_REFRESH_TOKEN", {
      MYRA_WRITES_ENABLED: "1",
      MYRA_CALENDAR_PROVIDER: "google",
    })
  })

  it("rejects each enabled mock calendar fault switch in production", async () => {
    for (const flag of [
      "MYRA_MOCK_CALENDAR_TIMEOUT_ON_INSERT",
      "MYRA_MOCK_CALENDAR_PENDING_CONFERENCE",
      "MYRA_MOCK_CALENDAR_EXTERNAL_CONFLICT",
    ]) {
      await expectRejectedFor(flag, { ...googleWriteEnv, [flag]: "1" })
    }
  })

  it("accepts the google provider with complete credentials when writes are enabled", async () => {
    const mod = await importEnv(googleWriteEnv)
    expect(mod.env.MYRA_CALENDAR_PROVIDER).toBe("google")
  })

  it("accepts MYRA_GOOGLE_TOKEN_JSON in place of the refresh token", async () => {
    const mod = await importEnv({
      ...googleWriteEnv,
      MYRA_GOOGLE_REFRESH_TOKEN: "",
      MYRA_GOOGLE_TOKEN_JSON: '{"refresh_token":"r"}',
    })
    expect(mod.env.MYRA_GOOGLE_TOKEN_JSON).toContain("refresh_token")
  })

  it("still allows the mock provider when writes are disabled", async () => {
    const mod = await importEnv({ MYRA_WRITES_ENABLED: "0" })
    expect(mod.env.MYRA_CALENDAR_PROVIDER).toBe("mock")
  })

  it("still allows the mock provider outside production", async () => {
    const mod = await importEnv({
      NODE_ENV: "development",
      MYRA_WRITES_ENABLED: "1",
      MYRA_MOCK_CALENDAR_TIMEOUT_ON_INSERT: "1",
    })
    expect(mod.env.MYRA_CALENDAR_PROVIDER).toBe("mock")
    expect(mod.env.MYRA_MOCK_CALENDAR_TIMEOUT_ON_INSERT).toBe("1")
  })
})
