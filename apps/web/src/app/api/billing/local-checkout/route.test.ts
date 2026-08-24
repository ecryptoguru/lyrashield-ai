import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  provider: "polar" as "polar" | "razorpay",
  limited: false,
  polarAdmission: "off",
  razorpayAdmission: "off",
  createPolar: vi.fn().mockResolvedValue("https://polar.example/local"),
  createRazorpay: vi.fn().mockResolvedValue({ id: "plink_1", url: "https://rzp.example/local" }),
  resolveAttribution: vi.fn().mockResolvedValue({ affiliateId: "aff_1", clickId: "click_1" }),
}))

vi.mock("@lyrashield/config", () => ({
  env: {
    get POLAR_LOCAL_BILLING_ADMISSION() {
      return mocks.polarAdmission
    },
    get RAZORPAY_LOCAL_BILLING_ADMISSION() {
      return mocks.razorpayAdmission
    },
    POLAR_LOCAL_PRODUCT_IDS: JSON.stringify({ individual_launch: "prod_launch" }),
    NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
  },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
vi.mock("@lyrashield/affiliate", () => ({
  parseAffiliateCookie: () => "opaque-cookie-token",
  resolveAttribution: mocks.resolveAttribution,
}))
vi.mock("@/lib/rate-limit", () => ({
  clientIpFromRequest: () => "203.0.113.4",
  checkBillingCheckoutRateLimit: vi.fn(() => ({ limited: mocks.limited })),
}))
vi.mock("@/lib/billing-admission", () => ({
  resolveRequestBillingProvider: () => ({
    provider: mocks.provider,
    region: mocks.provider === "polar" ? "usd" : "inr",
  }),
  localBillingAdmissionError: () => {
    const admission = mocks.provider === "polar" ? mocks.polarAdmission : mocks.razorpayAdmission
    return admission === "public" ? null : new Response(null, { status: 503 })
  },
}))
vi.mock("@lyrashield/billing", () => ({
  resolveProviderId: (raw: string, key: string) => JSON.parse(raw)[key] ?? null,
  createPolarOneTimeCheckout: mocks.createPolar,
  createRazorpayPaymentLink: mocks.createRazorpay,
  billingQuoteNotes: () => ({ quotedAmountMinor: "1990000", quoteSignature: "signed-quote" }),
}))

import { POST } from "./route"

function request(body: unknown = {}) {
  return new Request("https://app.lyrashieldai.com/api/billing/local-checkout", {
    method: "POST",
    headers: { cookie: "__ls_aff=opaque-cookie-token" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/billing/local-checkout", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.provider = "polar"
    mocks.limited = false
    mocks.polarAdmission = "off"
    mocks.razorpayAdmission = "off"
  })

  it("fails closed before provider calls while Local admission is off", async () => {
    const response = await POST(request())
    expect(response.status).toBe(503)
    expect(mocks.createPolar).not.toHaveBeenCalled()
  })

  it("rejects client-supplied catalog or payment choices", async () => {
    mocks.polarAdmission = "public"
    for (const body of [
      { sku: "individual_regular" },
      { amount: 1 },
      { provider: "razorpay" },
      { currency: "INR" },
    ]) {
      expect((await POST(request(body))).status).toBe(400)
    }
  })

  it("creates only the fixed Polar launch checkout with internal attribution IDs", async () => {
    mocks.polarAdmission = "public"
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.createPolar).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "prod_launch",
        metadata: expect.objectContaining({
          productId: "individual_launch",
          affiliate_id: "aff_1",
          click_id: "click_1",
        }),
      })
    )
    expect(JSON.stringify(mocks.createPolar.mock.calls)).not.toContain("opaque-cookie-token")
  })

  it("creates an INR 19,900 Razorpay link with partial payments disabled", async () => {
    mocks.provider = "razorpay"
    mocks.razorpayAdmission = "public"
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.createRazorpay).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1_990_000,
        partialPayment: false,
        referenceId: expect.stringMatching(/^local_/),
        notes: expect.objectContaining({
          quoteWorkspaceId: expect.stringMatching(/^local_/),
          quotedAmountMinor: "1990000",
          quoteSignature: "signed-quote",
        }),
      })
    )
  })

  it("rate-limits by trusted client IP before provider calls", async () => {
    mocks.polarAdmission = "public"
    mocks.limited = true
    expect((await POST(request())).status).toBe(429)
    expect(mocks.createPolar).not.toHaveBeenCalled()
  })
})
