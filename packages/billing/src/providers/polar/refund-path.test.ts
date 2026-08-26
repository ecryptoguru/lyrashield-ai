import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock reverseRefund so we can assert the refund.created path calls it.
vi.mock("../../usage/refund", () => ({
  reverseRefund: vi.fn().mockResolvedValue({ reversed: true, minutesReversed: 100 }),
}))
vi.mock("../../provider-catalog-validation", () => ({
  resolvePolarCatalogEvent: () => null,
}))

vi.mock("@lyrashield/pricing", () => ({
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

describe("Polar refund.created — FAIL-A2 unblock (refund reversal path)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("isHandledPolarEvent includes refund.created (was previously dead code)", () => {
    expect(isHandledPolarEvent("refund.created")).toBe(true)
  })

  it("processPolarEvent routes refund.created to reverseRefund", async () => {
    const result = await processPolarEvent({
      type: "refund.created",
      data: {
        id: "refund-1",
        order_id: "order-abc",
        metadata: { workspaceId: "ws-1" },
      },
    })

    expect(result.handled).toBe(true)
    expect(result.action).toBe("refund.reversed")
    expect(reverseRefund).toHaveBeenCalledOnce()
    expect(reverseRefund).toHaveBeenCalledWith("ws-1", "order-abc", "refund-1")
  })

  it("processPolarEvent returns not-handled when refund.created has no workspaceId", async () => {
    const result = await processPolarEvent({
      type: "refund.created",
      data: { id: "refund-2", order_id: "order-xyz", metadata: {} },
    })

    expect(result.handled).toBe(false)
    expect(result.action).toBe("refund.no_workspace")
    expect(reverseRefund).not.toHaveBeenCalled()
  })

  it("isHandledPolarEvent still covers the subscription events", () => {
    expect(isHandledPolarEvent("order.paid")).toBe(true)
    expect(isHandledPolarEvent("subscription.created")).toBe(true)
    expect(isHandledPolarEvent("subscription.canceled")).toBe(true)
    expect(isHandledPolarEvent("customer.state_changed")).toBe(true)
  })
})
