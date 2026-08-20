import { describe, expect, it } from "vitest"
import { getRazorpaySubscriptionCycleCount } from "./client"

describe("getRazorpaySubscriptionCycleCount", () => {
  it("keeps monthly and annual subscriptions renewable until cancellation", () => {
    expect(getRazorpaySubscriptionCycleCount("monthly")).toBe(1200)
    expect(getRazorpaySubscriptionCycleCount("annual")).toBe(100)
  })
})
