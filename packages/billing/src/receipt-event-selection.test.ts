import { describe, expect, it } from "vitest"
import {
  isProviderSubscriptionLifecycleReceipt,
  selectPolarSubscriptionCancellationEvent,
  selectPolarSubscriptionReceiptEvent,
  selectRazorpaySubscriptionCancellationEvent,
  selectRazorpaySubscriptionReceiptEvent,
} from "./receipt-event-selection"

const eventFor = (
  subscriptionId: string,
  externalId: string,
  eventType = "subscription.charged"
) => ({
  externalId,
  eventType,
  payload: { payload: { subscription: { entity: { id: subscriptionId } } } },
})

const polarEventFor = (subscriptionId: string, externalId: string, eventType: string) => ({
  externalId,
  eventType,
  payload: { type: eventType, data: { id: subscriptionId } },
})

const polarPaidOrderFor = (subscriptionId: string, externalId: string) => ({
  externalId,
  eventType: "order.paid",
  payload: { type: "order.paid", data: { id: "order_target", subscription_id: subscriptionId } },
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
    ).toThrow(
      "could not resolve one Razorpay subscription receipt event (charges 2, activations 0)"
    )
  })
})

describe("selectRazorpaySubscriptionCancellationEvent", () => {
  it("selects one exact provider-delivered cancellation", () => {
    expect(
      selectRazorpaySubscriptionCancellationEvent(
        [
          eventFor("sub_other", "other", "subscription.cancelled"),
          eventFor("sub_target", "target", "subscription.cancelled"),
        ],
        "sub_target"
      )
    ).toEqual({ externalId: "target", eventType: "subscription.cancelled" })
  })

  it("fails closed when the cancellation is absent or ambiguous", () => {
    expect(() => selectRazorpaySubscriptionCancellationEvent([], "sub_target")).toThrow(
      "could not resolve one Razorpay subscription cancellation event (cancellations 0)"
    )
    expect(() =>
      selectRazorpaySubscriptionCancellationEvent(
        [
          eventFor("sub_target", "first", "subscription.cancelled"),
          eventFor("sub_target", "second", "subscription.cancelled"),
        ],
        "sub_target"
      )
    ).toThrow("could not resolve one Razorpay subscription cancellation event (cancellations 2)")
  })
})

describe("Polar subscription receipt selection", () => {
  it("prefers one active event and falls back to one creation event", () => {
    expect(
      selectPolarSubscriptionReceiptEvent(
        [
          polarEventFor("sub_target", "created", "subscription.created"),
          polarEventFor("sub_target", "active", "subscription.active"),
        ],
        "sub_target"
      )
    ).toEqual({ externalId: "active", eventType: "subscription.active" })
    expect(
      selectPolarSubscriptionReceiptEvent(
        [polarEventFor("sub_target", "created", "subscription.created")],
        "sub_target"
      )
    ).toEqual({ externalId: "created", eventType: "subscription.created" })
  })

  it("accepts one paid order bound to the exact subscription", () => {
    expect(
      selectPolarSubscriptionReceiptEvent(
        [polarPaidOrderFor("sub_other", "other"), polarPaidOrderFor("sub_target", "paid")],
        "sub_target"
      )
    ).toEqual({ externalId: "paid", eventType: "order.paid" })
  })

  it("prefers one terminal revocation and falls back to one cancellation", () => {
    expect(
      selectPolarSubscriptionCancellationEvent(
        [polarEventFor("sub_target", "canceled", "subscription.canceled")],
        "sub_target"
      )
    ).toEqual({ externalId: "canceled", eventType: "subscription.canceled" })
    expect(
      selectPolarSubscriptionCancellationEvent(
        [
          polarEventFor("sub_target", "canceled", "subscription.canceled"),
          polarEventFor("sub_target", "revoked", "subscription.revoked"),
        ],
        "sub_target"
      )
    ).toEqual({ externalId: "revoked", eventType: "subscription.revoked" })
  })

  it("fails closed when the provider cancellation is ambiguous", () => {
    expect(() =>
      selectPolarSubscriptionCancellationEvent(
        [
          polarEventFor("sub_target", "canceled", "subscription.canceled"),
          polarEventFor("sub_target", "canceled-2", "subscription.canceled"),
        ],
        "sub_target"
      )
    ).toThrow("could not resolve one Polar subscription cancellation event (revoked 0, canceled 2)")
  })
})

describe("isProviderSubscriptionLifecycleReceipt", () => {
  it("binds purchase phases to provider purchase events", () => {
    expect(
      isProviderSubscriptionLifecycleReceipt({
        provider: "polar",
        phase: "purchase",
        eventType: "subscription.active",
        status: "active",
        canceledAt: false,
      })
    ).toBe(true)
    expect(
      isProviderSubscriptionLifecycleReceipt({
        provider: "polar",
        phase: "purchase",
        eventType: "order.paid",
        status: "active",
        canceledAt: false,
      })
    ).toBe(true)
    expect(
      isProviderSubscriptionLifecycleReceipt({
        provider: "polar",
        phase: "purchase",
        eventType: "subscription.canceled",
        status: "active",
        canceledAt: true,
      })
    ).toBe(false)
  })

  it("accepts scheduled Polar cancellation only when cancellation is recorded", () => {
    expect(
      isProviderSubscriptionLifecycleReceipt({
        provider: "polar",
        phase: "cancellation",
        eventType: "subscription.canceled",
        status: "active",
        canceledAt: true,
      })
    ).toBe(true)
    expect(
      isProviderSubscriptionLifecycleReceipt({
        provider: "polar",
        phase: "cancellation",
        eventType: "subscription.canceled",
        status: "active",
        canceledAt: false,
      })
    ).toBe(false)
  })

  it("requires Razorpay cancellation to produce canceled state", () => {
    expect(
      isProviderSubscriptionLifecycleReceipt({
        provider: "razorpay",
        phase: "cancellation",
        eventType: "subscription.cancelled",
        status: "canceled",
        canceledAt: false,
      })
    ).toBe(true)
    expect(
      isProviderSubscriptionLifecycleReceipt({
        provider: "razorpay",
        phase: "cancellation",
        eventType: "subscription.cancelled",
        status: "active",
        canceledAt: false,
      })
    ).toBe(false)
  })
})
