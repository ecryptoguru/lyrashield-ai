import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  checkoutClaim: "claimed" as "claimed" | "duplicate" | "unavailable",
  createRazorpay: vi.fn().mockResolvedValue({ id: "plink_1", url: "https://rzp.example/topup" }),
  billingQuoteNotes: vi.fn((quote: { amountMinor: number }) => ({
    quotedAmountMinor: String(quote.amountMinor),
    quoteSignature: "signed-quote",
  })),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: vi.fn() }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { billing: { manage: "billing:manage" } } }))
vi.mock("@lyrashield/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/rate-limit", () => ({
  checkBillingCheckoutRateLimit: vi.fn(() => ({ limited: false })),
  claimBillingCheckoutCreation: vi.fn(() => mocks.checkoutClaim),
}))
vi.mock("@/lib/billing-admission", () => ({
  billingAdmissionError: () => null,
  resolveRequestBillingProvider: () => ({ provider: "razorpay", region: "inr" }),
  paymentsUnavailableError: () => Response.json({ error: "unavailable" }, { status: 503 }),
}))
vi.mock("@lyrashield/config", () => ({
  env: { BILLING_USD_INR_RATE: 83.255, POLAR_PRODUCT_IDS: "" },
}))
vi.mock("@lyrashield/billing", () => ({
  createPolarOneTimeCheckout: vi.fn(),
  createRazorpayPaymentLink: mocks.createRazorpay,
  resolveProviderId: vi.fn(),
  billingQuoteNotes: mocks.billingQuoteNotes,
  MINUTE_PACK_MAP: {
    pack_100: { name: "100 agent-minutes", priceUsd: 15 },
  },
}))

import { POST } from "./route"

describe("POST /api/billing/topup Razorpay quote", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkoutClaim = "claimed"
  })

  it("uses one rounded paise amount for both the Payment Link and signed quote", async () => {
    const response = await POST(
      new Request("https://app.lyrashieldai.com/api/billing/topup", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1", pack: "pack_100" }),
      })
    )

    expect(response.status).toBe(200)
    expect(mocks.billingQuoteNotes).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 124_882, workspaceId: "workspace-1" })
    )
    expect(mocks.createRazorpay).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 124_882,
        notes: expect.objectContaining({
          quotedAmountMinor: "124882",
          quoteSignature: "signed-quote",
        }),
      })
    )
  })

  it("does not create a second provider payment link while checkout is in progress", async () => {
    mocks.checkoutClaim = "duplicate"
    const response = await POST(
      new Request("https://app.lyrashieldai.com/api/billing/topup", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1", pack: "pack_100" }),
      })
    )

    expect(response.status).toBe(409)
    expect(mocks.createRazorpay).not.toHaveBeenCalled()
  })
})
