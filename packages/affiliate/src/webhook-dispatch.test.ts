import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the commission handlers so we can assert which branch dispatch took.
vi.mock("./commission/engine", () => ({
  onOrderPaid: vi.fn(),
}))
vi.mock("./commission/local", () => ({
  onLocalOrderPaid: vi.fn(),
}))
vi.mock("./commission/clawback", () => ({
  onRefund: vi.fn(),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { dispatch } from "./webhook-dispatch"
import { onOrderPaid } from "./commission/engine"
import { onLocalOrderPaid } from "./commission/local"

describe("webhook-dispatch — minute-pack no-commission guard (C2)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("skips commission for a Polar minute-pack order (productId polar_pack_100)", async () => {
    const result = await dispatch({
      provider: "polar",
      event: "order.paid",
      payload: {
        id: "order-pk100",
        productId: "polar_pack_100",
        amount: "15.00",
        currency: "USD",
        metadata: { workspaceId: "ws-1", packId: "pack_100" },
      },
    })

    expect(result.handled).toBe(true)
    // The Cloud subscription handler must NOT be called for a minute pack
    expect(onOrderPaid).not.toHaveBeenCalled()
    // The Local-SKU handler must NOT be called either
    expect(onLocalOrderPaid).not.toHaveBeenCalled()
  })

  it("skips commission for a Razorpay minute-pack order (packId in metadata)", async () => {
    const result = await dispatch({
      provider: "razorpay",
      event: "order.paid",
      payload: {
        id: "order-rzpk250",
        productId: "razorpay_pack_250",
        amount: "30.00",
        currency: "USD",
        metadata: { workspaceId: "ws-2", packId: "pack_250" },
      },
    })

    expect(result.handled).toBe(true)
    expect(onOrderPaid).not.toHaveBeenCalled()
    expect(onLocalOrderPaid).not.toHaveBeenCalled()
  })

  it("routes a Cloud subscription order.paid to the Cloud commission handler", async () => {
    vi.mocked(onOrderPaid).mockResolvedValue({
      conversionId: "conv-1",
      commissionId: "comm-1",
      amount: "24.7500",
      rateBps: 2500,
      status: "PENDING",
      expired: false,
      duplicate: false,
    })

    const result = await dispatch({
      provider: "polar",
      event: "order.paid",
      payload: {
        id: "order-sub1",
        productId: "polar_product_pro_monthly",
        amount: "99.00",
        currency: "USD",
        subscriptionId: "sub-1",
        metadata: { workspaceId: "ws-3", plan: "PRO", interval: "monthly" },
      },
    })

    expect(result.handled).toBe(true)
    expect(onOrderPaid).toHaveBeenCalledOnce()
  })

  it("routes a Local-SKU order.paid to the Local commission handler (20% one-time)", async () => {
    vi.mocked(onLocalOrderPaid).mockResolvedValue({
      conversionId: "conv-2",
      commissionId: "comm-2",
      amount: "19.8000",
      rateBps: 2000,
      status: "PENDING",
      expired: false,
      duplicate: false,
    })

    const result = await dispatch({
      provider: "polar",
      event: "order.paid",
      payload: {
        id: "order-local1",
        productId: "individual_launch",
        amount: "199.00",
        currency: "USD",
        metadata: { workspaceId: "ws-4" },
      },
    })

    expect(result.handled).toBe(true)
    expect(onLocalOrderPaid).toHaveBeenCalledOnce()
    expect(onOrderPaid).not.toHaveBeenCalled()
  })
})
