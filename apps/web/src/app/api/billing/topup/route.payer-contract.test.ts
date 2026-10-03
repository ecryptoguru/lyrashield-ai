import { beforeEach, describe, expect, it, vi } from "vitest"

const config = vi.hoisted(() => ({
  BETTER_AUTH_URL: "https://app.lyrashieldai.com",
  NEXT_PUBLIC_APP_URL: "https://app.lyrashieldai.com",
  LYRASHIELD_INTERNAL_API_KEY: "test-internal-quote-secret",
  BILLING_USD_INR_RATE: 100,
  POLAR_PRODUCT_IDS: "",
}))
const mocks = vi.hoisted(() => ({
  createRazorpayPaymentLink: vi.fn(),
  requirePermission: vi.fn(),
  creditTopUp: vi.fn(),
  claimCheckout: vi.fn(),
}))

vi.mock("@lyrashield/config", () => ({ env: config }))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { billing: { manage: "billing:manage" } } }))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setRequestId: vi.fn(),
  setRequestIdResolver: vi.fn(),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkBillingCheckoutRateLimit: vi.fn().mockResolvedValue({ limited: false }),
  claimBillingCheckoutCreation: mocks.claimCheckout,
}))
vi.mock("@/lib/billing-admission", () => ({
  billingAdmissionError: vi.fn(() => null),
  paymentsUnavailableError: vi.fn(() => Response.json({ error: "unavailable" }, { status: 503 })),
  resolveRequestBillingProvider: vi.fn(() => ({ provider: "razorpay", region: "inr" })),
}))
vi.mock("@lyrashield/billing", async () => {
  // The route and settlement path share the production HMAC signer.
  const quote = await vi.importActual<
    typeof import("../../../../../../../packages/billing/src/provider-quote")
  >("../../../../../../../packages/billing/src/provider-quote")
  return {
    billingQuoteNotes: quote.billingQuoteNotes,
    createPolarOneTimeCheckout: vi.fn(),
    createRazorpayPaymentLink: mocks.createRazorpayPaymentLink,
    resolveProviderId: vi.fn(),
    MINUTE_PACK_MAP: { pack_100: { name: "100 agent-minutes", minutes: 100, priceUsd: 15 } },
  }
})
vi.mock("@lyrashield/db", () => ({}))
vi.mock("../../../../../../../packages/billing/src/usage/packs", () => ({
  creditTopUp: mocks.creditTopUp,
}))
vi.mock("../../../../../../../packages/billing/src/usage/refund", () => ({
  reverseRefund: vi.fn(),
}))
vi.mock("../../../../../../../packages/billing/src/sync", () => ({
  syncSubscription: vi.fn(),
  downgradeToFree: vi.fn(),
}))
vi.mock("../../../../../../../packages/billing/src/license-fulfillment", () => ({
  issueLicenseForProviderOrder: vi.fn(),
  parseLocalProductIds: () => ({}),
}))

import { MINUTE_PACK_MAP } from "@lyrashield/pricing"
import { processRazorpayEvent } from "../../../../../../../packages/billing/src/providers/razorpay/adapter"
import type { RazorpayWebhookEvent } from "../../../../../../../packages/billing/src/providers/razorpay/webhooks"
import { verifyBillingQuote } from "../../../../../../../packages/billing/src/provider-quote"
import { POST } from "./route"
import { creditTopUp } from "../../../../../../../packages/billing/src/usage/packs"

const WORKSPACE = "workspace_checkout"
const BUYER_ACCOUNT = "acct_checkout_owner"
const PACK_AMOUNT = 150_000

function capturedEvent(paymentId: string, notes: Record<string, string>): RazorpayWebhookEvent {
  return {
    event: "payment.captured",
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: paymentId,
          amount: PACK_AMOUNT,
          currency: "INR",
          notes,
        },
      },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requirePermission.mockResolvedValue({ session: { userId: BUYER_ACCOUNT } })
  mocks.claimCheckout.mockResolvedValue("claimed")
  mocks.createRazorpayPaymentLink.mockResolvedValue({
    id: "plink_checkout",
    url: "https://rzp.example/pay",
  })
  mocks.creditTopUp.mockResolvedValue({ created: true, minutes: 100, packId: "pack_1" })
})

describe("Razorpay checkout producer to webhook settlement contract", () => {
  it("settles the checkout's actual payer-bound quote and rejects a grafted accountId", async () => {
    const response = await POST(
      new Request("https://app.lyrashieldai.com/api/billing/topup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: WORKSPACE, pack: "pack_100" }),
      })
    )

    expect(response.status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith(WORKSPACE, "billing:manage")
    const paymentLink = mocks.createRazorpayPaymentLink.mock.calls[0]?.[0]
    expect(paymentLink).toMatchObject({ amount: PACK_AMOUNT })
    const notes = paymentLink.notes as Record<string, string>
    expect(notes).toMatchObject({
      workspaceId: WORKSPACE,
      accountId: BUYER_ACCOUNT,
      packId: "pack_100",
    })
    expect(
      verifyBillingQuote(
        {
          provider: "razorpay",
          kind: "pack",
          workspaceId: WORKSPACE,
          accountId: BUYER_ACCOUNT,
          catalogKey: "pack_100",
          amountMinor: PACK_AMOUNT,
          currency: "INR",
        },
        notes,
        PACK_AMOUNT
      )
    ).toBe(true)

    await processRazorpayEvent(capturedEvent("pay_checkout", notes))
    expect(creditTopUp).toHaveBeenCalledTimes(1)
    expect(creditTopUp).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: BUYER_ACCOUNT,
        workspaceId: WORKSPACE,
        provider: "razorpay",
        externalId: "pay_checkout",
        minutes: MINUTE_PACK_MAP.pack_100.minutes,
      })
    )

    const tamperedNotes = { ...notes, accountId: "acct_attacker" }
    await expect(
      processRazorpayEvent(capturedEvent("pay_grafted", tamperedNotes))
    ).rejects.toThrow()
    expect(creditTopUp).toHaveBeenCalledTimes(1)
  })
})
