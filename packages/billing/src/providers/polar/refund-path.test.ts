import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/config", () => ({ env: {} }))

// Mock reverseRefund so we can assert the refund.created path calls it.
vi.mock("../../usage/refund", () => ({
  reverseRefund: vi.fn().mockResolvedValue({ reversed: true, minutesReversed: 100 }),
}))
vi.mock("../../provider-catalog-validation", () => ({
  resolvePolarCatalogEvent: () => null,
}))

vi.mock("@lyrashield/pricing", () => ({
  extractProductId: () => null,
  isLocalSkuOrderPayload: () => false,
  isMinutePackOrderPayload: (payload: Record<string, unknown>) =>
    Boolean((payload.metadata as Record<string, unknown> | undefined)?.packId),
  MINUTE_PACK_MAP: {
    pack_100: { id: "pack_100", minutes: 100, priceUsd: 15 },
    pack_250: { id: "pack_250", minutes: 250, priceUsd: 30 },
    pack_500: { id: "pack_500", minutes: 500, priceUsd: 50 },
  },
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

import { isHandledPolarEvent } from "./webhooks"
import { processPolarEvent } from "./adapter"
import { reverseRefund } from "../../usage/refund"

describe("Polar refund evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("handles refund rows and authoritative order refund events", () => {
    expect(isHandledPolarEvent("refund.created")).toBe(true)
    expect(isHandledPolarEvent("order.refunded")).toBe(true)
  })

  it("records refund.created without reversing entitlement", async () => {
    const result = await processPolarEvent({
      type: "refund.created",
      data: {
        id: "refund-1",
        order_id: "order-abc",
        metadata: { workspaceId: "ws-1" },
      },
    })

    expect(result).toEqual({
      handled: true,
      action: "refund.created.recorded",
      workspaceId: "ws-1",
    })
    expect(reverseRefund).not.toHaveBeenCalled()
  })

  it("reverses a minute pack only from a full order.refunded event", async () => {
    const result = await processPolarEvent({
      type: "order.refunded",
      data: {
        id: "order-xyz",
        status: "refunded",
        total_amount: 1500,
        currency: "USD",
        metadata: { workspaceId: "ws-1", packId: "pack_100" },
      },
    })

    expect(result.action).toBe("order.refunded.reversed")
    expect(reverseRefund).toHaveBeenCalledWith("ws-1", "order-xyz", "order-xyz")
  })

  it("records partial order refunds without entitlement mutation", async () => {
    const result = await processPolarEvent({
      type: "order.refunded",
      data: {
        id: "order-partial",
        status: "partially_refunded",
        total_amount: 1500,
        currency: "USD",
        metadata: { workspaceId: "ws-1", packId: "pack_100" },
      },
    })

    expect(result.action).toBe("order.refunded.not_full_recorded")
    expect(reverseRefund).not.toHaveBeenCalled()
  })

  it("records a full subscription refund without touching minute-pack entitlement", async () => {
    const result = await processPolarEvent({
      type: "order.refunded",
      data: {
        id: "order-subscription",
        status: "refunded",
        total_amount: 4900,
        currency: "USD",
        subscription_id: "sub-1",
        metadata: { workspaceId: "ws-1", planId: "individual_monthly" },
      },
    })

    expect(result.action).toBe("order.refunded.full_recorded")
    expect(reverseRefund).not.toHaveBeenCalled()
  })

  it("isHandledPolarEvent still covers the subscription events", () => {
    expect(isHandledPolarEvent("order.paid")).toBe(true)
    expect(isHandledPolarEvent("subscription.created")).toBe(true)
    expect(isHandledPolarEvent("subscription.canceled")).toBe(true)
    expect(isHandledPolarEvent("customer.state_changed")).toBe(true)
  })
})
