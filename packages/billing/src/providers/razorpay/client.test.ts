import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  cancelPaymentLink: vi.fn(),
  createSubscription: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock("razorpay", () => ({
  default: class Razorpay {
    paymentLink = { cancel: mocks.cancelPaymentLink }
    subscriptions = { create: mocks.createSubscription }
  },
}))
vi.mock("@lyrashield/config", () => ({
  env: { RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "test-secret" },
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { error: mocks.loggerError, warn: vi.fn() },
}))

import {
  cancelRazorpayPaymentLink,
  createRazorpaySubscription,
  getRazorpaySubscriptionCycleCount,
} from "./client"

describe("getRazorpaySubscriptionCycleCount", () => {
  it("keeps monthly and annual subscriptions renewable until cancellation", () => {
    expect(getRazorpaySubscriptionCycleCount("monthly")).toBe(1200)
    expect(getRazorpaySubscriptionCycleCount("annual")).toBe(100)
  })
})

describe("cancelRazorpayPaymentLink", () => {
  beforeEach(() => vi.clearAllMocks())

  it("cancels the exact payment link and reports provider failures", async () => {
    mocks.cancelPaymentLink.mockResolvedValueOnce({ id: "plink_1", status: "cancelled" })
    await expect(cancelRazorpayPaymentLink("plink_1")).resolves.toBe(true)
    expect(mocks.cancelPaymentLink).toHaveBeenCalledWith("plink_1")

    mocks.cancelPaymentLink.mockRejectedValueOnce(new Error("provider unavailable"))
    await expect(cancelRazorpayPaymentLink("plink_2")).resolves.toBe(false)
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Failed to cancel Razorpay payment link",
      expect.objectContaining({ paymentLinkId: "plink_2" })
    )
  })
})

describe("createRazorpaySubscription", () => {
  beforeEach(() => vi.clearAllMocks())

  it("preserves the explicit customer and cycle count", async () => {
    mocks.createSubscription.mockResolvedValueOnce({ id: "sub_1" })

    await expect(
      createRazorpaySubscription({
        planId: "plan_monthly",
        customerId: "cust_1",
        totalCount: 1200,
        notes: { workspaceId: "workspace_1" },
      })
    ).resolves.toBe("sub_1")

    expect(mocks.createSubscription).toHaveBeenCalledWith({
      plan_id: "plan_monthly",
      customer_id: "cust_1",
      customer_notify: 1,
      quantity: 1,
      total_count: 1200,
      notes: { workspaceId: "workspace_1" },
    })
  })
})
