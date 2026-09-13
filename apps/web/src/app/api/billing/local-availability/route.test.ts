import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  provider: "polar" as "polar" | "razorpay",
  polarAdmission: "off" as string,
  razorpayAdmission: "off" as string,
  limited: false,
}))

vi.mock("@lyrashield/billing", () => ({
  getLocalBillingAdmission: (provider: "polar" | "razorpay") => {
    const mode = provider === "polar" ? mocks.polarAdmission : mocks.razorpayAdmission
    return mode === "public"
      ? { allowed: true, mode, reason: "public" }
      : { allowed: false, mode, reason: "provider_off" }
  },
}))
vi.mock("@/lib/billing-admission", () => ({
  resolveRequestBillingProvider: () => ({
    provider: mocks.provider,
    region: mocks.provider === "polar" ? "usd" : "inr",
  }),
}))
vi.mock("@/lib/rate-limit", () => ({
  clientIpFromRequest: () => "203.0.113.4",
  checkApiRateLimit: vi.fn(async () => ({ limited: mocks.limited })),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET, OPTIONS } from "./route"

const MARKETING_ORIGIN = "https://lyrashieldai.com"

function request(origin?: string) {
  return new Request("https://app.lyrashieldai.com/api/billing/local-availability", {
    headers: origin ? { origin } : {},
  })
}

describe("GET /api/billing/local-availability", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_MARKETING_URL = MARKETING_ORIGIN
    process.env.NEXT_PUBLIC_APP_URL = "https://app.lyrashieldai.com"
    mocks.provider = "polar"
    mocks.polarAdmission = "off"
    mocks.razorpayAdmission = "off"
    mocks.limited = false
  })

  it("reports unavailable when the resolved provider's local admission is off", async () => {
    const response = await GET(request(MARKETING_ORIGIN))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ provider: "polar", available: false })
    expect(response.headers.get("access-control-allow-origin")).toBe(MARKETING_ORIGIN)
    expect(response.headers.get("cache-control")).toContain("no-store")
  })

  it("reports available only when the resolved provider's admission is public", async () => {
    mocks.polarAdmission = "public"
    const response = await GET(request(MARKETING_ORIGIN))
    await expect(response.json()).resolves.toEqual({ provider: "polar", available: true })
  })

  it("is provider-aware: Razorpay on does not open Polar", async () => {
    mocks.razorpayAdmission = "public"
    const response = await GET(request(MARKETING_ORIGIN))
    await expect(response.json()).resolves.toEqual({ provider: "polar", available: false })
  })

  it("resolves the Razorpay context to its own admission state", async () => {
    mocks.provider = "razorpay"
    mocks.razorpayAdmission = "public"
    const response = await GET(request(MARKETING_ORIGIN))
    await expect(response.json()).resolves.toEqual({ provider: "razorpay", available: true })
  })

  it("answers same-origin requests without CORS headers", async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("answers foreign origins without CORS so the browser withholds the body", async () => {
    const response = await GET(request("https://evil.example"))
    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("rate limits by client IP", async () => {
    mocks.limited = true
    const response = await GET(request(MARKETING_ORIGIN))
    expect(response.status).toBe(429)
  })

  it("preflights only trusted origins", () => {
    expect(OPTIONS(request(MARKETING_ORIGIN)).status).toBe(204)
    expect(OPTIONS(request("https://evil.example")).status).toBe(403)
  })
})
