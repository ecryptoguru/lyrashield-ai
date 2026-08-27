import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  cancelPaymentLink: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock("razorpay", () => ({
  default: class Razorpay {
    paymentLink = { cancel: mocks.cancelPaymentLink }
  },
}))
vi.mock("@lyrashield/config", () => ({
  env: { RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "test-secret" },
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { error: mocks.loggerError, warn: vi.fn() },
}))

import { cancelRazorpayPaymentLink, getRazorpaySubscriptionCycleCount } from "./client"

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
