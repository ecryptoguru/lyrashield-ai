import { describe, expect, it } from "vitest"
import { selectRazorpaySubscriptionChargeEvent } from "./receipt-event-selection"

const eventFor = (subscriptionId: string, externalId: string) => ({
  externalId,
  payload: { payload: { subscription: { entity: { id: subscriptionId } } } },
})

describe("selectRazorpaySubscriptionChargeEvent", () => {
  it("selects the exact subscription's one processed charge", () => {
    expect(
      selectRazorpaySubscriptionChargeEvent(
        [eventFor("sub_other", "other"), eventFor("sub_target", "target")],
        "sub_target"
      )
    ).toBe("target")
  })

  it("fails closed when the provider delivery is absent or ambiguous", () => {
    expect(() => selectRazorpaySubscriptionChargeEvent([], "sub_target")).toThrow(
      "could not resolve one Razorpay subscription charge event (found 0)"
    )
    expect(() =>
      selectRazorpaySubscriptionChargeEvent(
        [eventFor("sub_target", "first"), eventFor("sub_target", "second")],
        "sub_target"
      )
    ).toThrow("could not resolve one Razorpay subscription charge event (found 2)")
  })
})
