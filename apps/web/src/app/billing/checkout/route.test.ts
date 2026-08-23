import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  provider: "polar" as "polar" | "razorpay",
  providerConfigured: true,
  limited: false,
  admissionResponse: null as Response | null,
  requirePermission: vi.fn(),
  billingAdmissionError: vi.fn(),
  createPolarCheckout: vi.fn().mockResolvedValue("https://checkout.polar.example/session"),
  createRazorpaySubscription: vi.fn().mockResolvedValue("sub_test"),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { billing: { manage: "billing:manage" } } }))
vi.mock("@lyrashield/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/affiliate", () => ({ resolveAttribution: vi.fn().mockResolvedValue(null) }))
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
    POLAR_PRODUCT_IDS: JSON.stringify({ starter_monthly: "polar_starter" }),
    RAZORPAY_PLAN_IDS: JSON.stringify({ starter_monthly: "razorpay_starter" }),
    RAZORPAY_KEY_ID: "rzp_test_public_identifier",
  },
}))
vi.mock("@lyrashield/billing", () => ({
  resolveProvider: () => ({
    provider: mocks.provider,
    region: mocks.provider === "polar" ? "usd" : "inr",
  }),
  createPolarCheckout: mocks.createPolarCheckout,
  createRazorpaySubscription: mocks.createRazorpaySubscription,
  getRazorpaySubscriptionCycleCount: () => 1200,
  resolveProviderId: (raw: string, key: string) =>
    mocks.providerConfigured ? (JSON.parse(raw)[key] ?? null) : null,
  CLOUD_PLAN_MAP: { STARTER: { selfServe: true } },
}))

import { POST } from "./route"

function request() {
  return new Request("http://localhost/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ workspaceId: "workspace-a", plan: "STARTER", interval: "monthly" }),
  })
}

describe("POST /billing/checkout admission", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.provider = "polar"
    mocks.providerConfigured = true
    mocks.limited = false
    mocks.admissionResponse = null
  })

  it("returns a stable unavailable response before any provider request", async () => {
    mocks.admissionResponse = Response.json(
      {
        success: false,
        error: { code: "PAYMENTS_UNAVAILABLE", message: "Payments are temporarily unavailable." },
      },
      { status: 503 }
    )
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe("PAYMENTS_UNAVAILABLE")
    expect(mocks.billingAdmissionError).toHaveBeenCalledWith("polar", "workspace-a")
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled()
    expect(mocks.createRazorpaySubscription).not.toHaveBeenCalled()
  })

  it("creates an admitted Polar checkout", async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.createPolarCheckout).toHaveBeenCalledOnce()
  })

  it("creates an admitted Razorpay subscription", async () => {
    mocks.provider = "razorpay"
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.createRazorpaySubscription).toHaveBeenCalledOnce()
  })

  it("preserves rate limiting before admission and provider calls", async () => {
    mocks.limited = true
    const response = await POST(request())
    expect(response.status).toBe(429)
    expect(mocks.billingAdmissionError).not.toHaveBeenCalled()
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled()
  })

  it("returns the safe unavailable response for admitted provider misconfiguration", async () => {
    mocks.providerConfigured = false
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe("PAYMENTS_UNAVAILABLE")
    expect(mocks.createPolarCheckout).not.toHaveBeenCalled()
  })
})
