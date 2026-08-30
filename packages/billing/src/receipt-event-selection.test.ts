import { describe, expect, it } from "vitest"
import { selectRazorpaySubscriptionReceiptEvent } from "./receipt-event-selection"

const eventFor = (subscriptionId: string, externalId: string, eventType = "subscription.charged") => ({
  externalId,
  eventType,
  payload: { payload: { subscription: { entity: { id: subscriptionId } } } },
})

describe("selectRazorpaySubscriptionReceiptEvent", () => {
  it("selects the exact subscription's one processed charge", () => {
    expect(
      selectRazorpaySubscriptionReceiptEvent(
        [eventFor("sub_other", "other"), eventFor("sub_target", "target")],
        "sub_target"
      )
    ).toEqual({ externalId: "target", eventType: "subscription.charged" })
  })

  it("accepts one activation only when no matching charge exists", () => {
    expect(
      selectRazorpaySubscriptionReceiptEvent(
        [eventFor("sub_target", "activation", "subscription.activated")],
        "sub_target"
      )
    ).toEqual({ externalId: "activation", eventType: "subscription.activated" })
  })

  it("fails closed when the provider delivery is absent or ambiguous", () => {
    expect(() => selectRazorpaySubscriptionReceiptEvent([], "sub_target")).toThrow(
      "could not resolve one Razorpay subscription receipt event (charges 0, activations 0)"
    )
    expect(() =>
      selectRazorpaySubscriptionReceiptEvent(
        [eventFor("sub_target", "first"), eventFor("sub_target", "second")],
        "sub_target"
      )
    ).toThrow("could not resolve one Razorpay subscription receipt event (charges 2, activations 0)")
  })
})
