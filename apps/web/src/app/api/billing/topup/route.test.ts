import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  provider: "polar" as "polar" | "razorpay",
  providerConfigured: true,
  limited: false,
  admissionResponse: null as Response | null,
  billingAdmissionError: vi.fn(),
  createPolarOneTimeCheckout: vi.fn().mockResolvedValue("https://checkout.polar.example/pack"),
  createRazorpayPaymentLink: vi
    .fn()
    .mockResolvedValue({ id: "plink_test", url: "https://rzp.example/pack" }),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: vi.fn() }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { billing: { manage: "billing:manage" } } }))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/rate-limit", () => ({
  checkBillingCheckoutRateLimit: vi.fn(() => ({ limited: mocks.limited })),
}))
vi.mock("@/lib/billing-admission", () => ({
  billingAdmissionError: (...args: unknown[]) => {
    mocks.billingAdmissionError(...args)
    return mocks.admissionResponse
  },
  paymentsUnavailableError: () =>
    Response.json(
      { success: false, error: { code: "PAYMENTS_UNAVAILABLE", message: "Unavailable" } },
      { status: 503 }
    ),
}))
vi.mock("@lyrashield/config", () => ({
  env: {
    POLAR_PRODUCT_IDS: JSON.stringify({ pack_100: "polar_pack" }),
    BILLING_USD_INR_RATE: 100,
  },
}))
vi.mock("@lyrashield/billing", () => ({
  resolveProvider: () => ({ provider: mocks.provider, region: "usd" }),
  createPolarOneTimeCheckout: mocks.createPolarOneTimeCheckout,
  createRazorpayPaymentLink: mocks.createRazorpayPaymentLink,
  resolveProviderId: (raw: string, key: string) =>
    mocks.providerConfigured ? (JSON.parse(raw)[key] ?? null) : null,
  MINUTE_PACK_MAP: { pack_100: { priceUsd: 10, name: "100 minute pack" } },
}))

import { POST } from "./route"

function request() {
  return new Request("http://localhost/api/billing/topup", {
    method: "POST",
    body: JSON.stringify({ workspaceId: "workspace-a", pack: "pack_100" }),
  })
}

describe("POST /api/billing/topup admission", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.provider = "polar"
    mocks.providerConfigured = true
    mocks.limited = false
    mocks.admissionResponse = null
  })

  it("returns a stable unavailable response before any provider request", async () => {
    mocks.admissionResponse = Response.json(
      { success: false, error: { code: "PAYMENTS_UNAVAILABLE", message: "Unavailable" } },
      { status: 503 }
    )
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(mocks.billingAdmissionError).toHaveBeenCalledWith("polar", "workspace-a")
    expect(mocks.createPolarOneTimeCheckout).not.toHaveBeenCalled()
    expect(mocks.createRazorpayPaymentLink).not.toHaveBeenCalled()
  })

  it("creates an admitted Polar top-up checkout", async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.createPolarOneTimeCheckout).toHaveBeenCalledOnce()
  })

  it("creates an admitted Razorpay top-up checkout", async () => {
    mocks.provider = "razorpay"
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.createRazorpayPaymentLink).toHaveBeenCalledOnce()
  })

  it("preserves rate limiting before admission and provider calls", async () => {
    mocks.limited = true
    const response = await POST(request())
    expect(response.status).toBe(429)
    expect(mocks.billingAdmissionError).not.toHaveBeenCalled()
    expect(mocks.createPolarOneTimeCheckout).not.toHaveBeenCalled()
    expect(mocks.createRazorpayPaymentLink).not.toHaveBeenCalled()
  })

  it("returns the safe unavailable response for admitted provider misconfiguration", async () => {
    mocks.providerConfigured = false
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe("PAYMENTS_UNAVAILABLE")
    expect(mocks.createPolarOneTimeCheckout).not.toHaveBeenCalled()
  })
})
