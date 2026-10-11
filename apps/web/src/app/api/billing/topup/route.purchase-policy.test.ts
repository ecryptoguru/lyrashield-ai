import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  billing: vi.fn(),
  trial: vi.fn(),
  checkoutClaim: vi.fn(),
  createRazorpay: vi.fn(),
  resolveProvider: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "buyer-account" } }),
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { billing: { manage: "billing:manage" } } }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkBillingCheckoutRateLimit: vi.fn().mockResolvedValue({ limited: false }),
  claimBillingCheckoutCreation: mocks.checkoutClaim,
}))
vi.mock("@/lib/billing-admission", () => ({
  billingAdmissionError: vi.fn(() => null),
  paymentsUnavailableError: vi.fn(() => Response.json({ error: "unavailable" }, { status: 503 })),
  resolveRequestBillingProvider: mocks.resolveProvider,
}))
vi.mock("@lyrashield/config", () => ({
  env: { BILLING_USD_INR_RATE: 83.255, POLAR_PRODUCT_IDS: "" },
}))
vi.mock("@lyrashield/billing", () => ({
  createPolarOneTimeCheckout: vi.fn(),
  createRazorpayPaymentLink: mocks.createRazorpay,
  resolveProviderId: vi.fn(),
  billingQuoteNotes: vi.fn(() => ({ quotedAmountMinor: "124882", quoteSignature: "signed" })),
  canPurchaseMinutePack: (input: { effectivePlan: string; trialState: { isExpired: boolean } }) =>
    !(input.effectivePlan === "FREE" && input.trialState.isExpired),
  resolveAccountBilling: mocks.billing,
  getAccountTrialState: mocks.trial,
  MINUTE_PACK_MAP: { pack_100: { name: "100 agent-minutes", priceUsd: 15 } },
}))

import { POST } from "./route"

const request = () =>
  new Request("https://app.lyrashieldai.com/api/billing/topup", {
    method: "POST",
    body: JSON.stringify({ workspaceId: "agency-workspace", pack: "pack_100" }),
  })

describe("minute-pack checkout policy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.billing.mockResolvedValue({ effectivePlan: "FREE" })
    mocks.trial.mockResolvedValue({ isExpired: false, isActive: false })
    mocks.checkoutClaim.mockResolvedValue("claimed")
    mocks.createRazorpay.mockResolvedValue({ id: "payment-link", url: "https://pay.example.test" })
    mocks.resolveProvider.mockReturnValue({ provider: "razorpay", region: "inr" })
  })

  it("blocks only an expired-trial FREE buyer before provider or checkout work", async () => {
    mocks.trial.mockResolvedValue({ isExpired: true, isActive: false })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toMatchObject({
      code: "PACK_REQUIRES_SUBSCRIPTION",
      message:
        "Subscribe to a plan before buying a minute pack. Pack minutes cannot be used while your trial is expired.",
    })
    expect(mocks.billing).toHaveBeenCalledWith("buyer-account")
    expect(mocks.trial).toHaveBeenCalledWith("buyer-account")
    expect(mocks.resolveProvider).not.toHaveBeenCalled()
    expect(mocks.checkoutClaim).not.toHaveBeenCalled()
    expect(mocks.createRazorpay).not.toHaveBeenCalled()
  })

  it.each([
    ["FREE without a trial", { effectivePlan: "FREE" }, { isExpired: false, isActive: false }],
    ["an active FREE trial", { effectivePlan: "FREE" }, { isExpired: false, isActive: true }],
    ["a paid plan with an old expired trial", { effectivePlan: "PRO" }, { isExpired: true }],
  ])("allows %s", async (_label, billing, trial) => {
    mocks.billing.mockResolvedValue(billing)
    mocks.trial.mockResolvedValue(trial)

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mocks.checkoutClaim).toHaveBeenCalledOnce()
    expect(mocks.createRazorpay).toHaveBeenCalledOnce()
  })

  it("treats a missing account plan as FREE and blocks an expired trial", async () => {
    mocks.billing.mockResolvedValue(null)
    mocks.trial.mockResolvedValue({ isExpired: true })

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(mocks.checkoutClaim).not.toHaveBeenCalled()
    expect(mocks.createRazorpay).not.toHaveBeenCalled()
  })

  it("fails closed when buyer billing state cannot be read", async () => {
    mocks.billing.mockRejectedValue(new Error("billing read failed"))

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mocks.resolveProvider).not.toHaveBeenCalled()
    expect(mocks.checkoutClaim).not.toHaveBeenCalled()
    expect(mocks.createRazorpay).not.toHaveBeenCalled()
  })
})
