import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({ env: {} }))
vi.mock("../../provider-catalog-validation", () => ({
  resolveRazorpayCatalogEvent: () => ({ kind: "local", sku: "individual_launch" }),
}))

vi.mock("../../usage/refund", () => ({
  reverseRefund: vi.fn().mockResolvedValue({ reversed: true, minutesReversed: 100 }),
}))

vi.mock("@lyrashield/pricing", () => ({
  MINUTE_PACK_MAP: {},
}))

vi.mock("@lyrashield/db", () => ({
  prisma: {
    billingAccount: { update: vi.fn() },
    workspace: { update: vi.fn() },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { processRazorpayEvent } from "./adapter"
import { isHandledRazorpayEvent } from "./webhooks"
import { reverseRefund } from "../../usage/refund"

describe("Razorpay refund.created", () => {
  beforeEach(() => vi.clearAllMocks())

  it("routes the documented refund.created payload to reverseRefund", async () => {
    expect(isHandledRazorpayEvent("refund.created")).toBe(true)
    expect(isHandledRazorpayEvent("payment.refunded")).toBe(false)

    const result = await processRazorpayEvent({
      event: "refund.created",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        refund: { entity: { id: "rfnd-1", payment_id: "pay-1" } },
        payment: {
          entity: {
            id: "pay-1",
            amount: 1500,
            currency: "INR",
            notes: { workspaceId: "ws-1" },
          },
        },
      },
    })

    expect(result).toEqual({
      handled: true,
      action: "refund.created.reversed",
      workspaceId: "ws-1",
    })
    expect(reverseRefund).toHaveBeenCalledWith("ws-1", "pay-1", "rfnd-1")
  })

  it("accepts the hosted Local payment-link paid event without inventing a billing mutation", async () => {
    expect(isHandledRazorpayEvent("payment_link.paid")).toBe(true)
    await expect(
      processRazorpayEvent({
        event: "payment_link.paid",
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment: { entity: { id: "pay-local", amount: 1_990_000, currency: "INR" } },
          payment_link: {
            entity: { id: "plink-local", notes: { productId: "individual_launch" } },
          },
        },
      })
    ).resolves.toEqual({
      handled: true,
      action: "payment_link.paid.received",
      workspaceId: null,
    })
  })
})
