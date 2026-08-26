import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/config", () => ({ env: {} }))
vi.mock("../../provider-catalog-validation", () => ({
  resolveRazorpayCatalogEvent: () => ({ kind: "local", sku: "individual_launch" }),
}))

vi.mock("../../usage/refund", () => ({
  reverseRefund: vi.fn().mockResolvedValue({ reversed: true, minutesReversed: 100 }),
}))

vi.mock("@lyrashield/pricing", () => ({
  extractProductId: () => null,
  isLocalSkuOrderPayload: () => false,
  isMinutePackOrderPayload: (payload: Record<string, unknown>) =>
    Boolean((payload.notes as Record<string, unknown> | undefined)?.packId),
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

  it("routes only a processed cumulative full pack refund to reverseRefund", async () => {
    expect(isHandledRazorpayEvent("refund.created")).toBe(true)
    expect(isHandledRazorpayEvent("payment.refunded")).toBe(false)

    const result = await processRazorpayEvent({
      event: "refund.created",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        refund: {
          entity: {
            id: "rfnd-1",
            payment_id: "pay-1",
            amount: 500,
            currency: "INR",
            status: "processed",
          },
        },
        payment: {
          entity: {
            id: "pay-1",
            amount: 1500,
            amount_refunded: 1500,
            currency: "INR",
            refund_status: "full",
            notes: { workspaceId: "ws-1", packId: "pack_100" },
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

  it("records partial and currency-mismatched refunds without mutation", async () => {
    for (const refund of [
      { amount: 500, currency: "INR", status: "processed" },
      { amount: 1500, currency: "USD", status: "processed" },
    ]) {
      const result = await processRazorpayEvent({
        event: "refund.created",
        payload: {
          refund: { entity: { id: "rfnd-2", payment_id: "pay-2", ...refund } },
          payment: {
            entity: {
              id: "pay-2",
              amount: 1500,
              amount_refunded: refund.amount,
              currency: "INR",
              refund_status: refund.amount === 1500 ? "full" : "partial",
              notes: { workspaceId: "ws-1", packId: "pack_100" },
            },
          },
        },
      })
      expect(result.action).toBe("refund.created.not_full_recorded")
    }
    expect(reverseRefund).not.toHaveBeenCalled()
  })

  it("records a full subscription refund without touching minute-pack entitlement", async () => {
    const result = await processRazorpayEvent({
      event: "refund.created",
      payload: {
        refund: {
          entity: {
            id: "rfnd-sub",
            payment_id: "pay-sub",
            amount: 90000,
            currency: "INR",
            status: "processed",
          },
        },
        payment: {
          entity: {
            id: "pay-sub",
            amount: 290000,
            amount_refunded: 290000,
            currency: "INR",
            refund_status: "full",
            notes: { workspaceId: "ws-1", planId: "individual_monthly" },
          },
        },
      },
    })

    expect(result.action).toBe("refund.created.full_recorded")
    expect(reverseRefund).not.toHaveBeenCalled()
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
