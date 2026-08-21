import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * env is mocked so the Polar product-id map is deterministic without touching
 * the real zod-validated config. parseLocalProductIds() reads
 * env.POLAR_LOCAL_PRODUCT_IDS at call time.
 */
const envState = vi.hoisted(
  () =>
    ({
      NODE_ENV: "test",
    }) as Record<string, string | undefined>
)

vi.mock("@lyrashield/config", () => ({ env: envState }))
vi.mock("@lyrashield/db", () => ({
  prisma: {},
  getSystemPrisma: vi.fn(() => ({})),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { normalizeProviderEvent, type NormalizedBillingEvent } from "./domain-events"

afterEach(() => {
  delete envState.POLAR_LOCAL_PRODUCT_IDS
})

describe("normalizeProviderEvent", () => {
  it("d) maps a Polar local purchase to local_purchase_paid with productKind 'local'", () => {
    const event = normalizeProviderEvent({
      provider: "polar",
      eventType: "order.paid",
      deliveryId: "del_polar_1",
      payload: {
        type: "order.paid",
        data: {
          id: "ord_POLAR_1",
          productId: "individual_regular",
          customer_email: "buyer@example.com",
          seats: 1,
          created_at: "2026-08-01T00:00:00Z",
        },
      },
    })

    expect(event.kind).toBe("local_purchase_paid")
    expect(event.productKind).toBe("local")
    expect(event.orderId).toBe("ord_POLAR_1")
    expect(event.provider).toBe("polar")
    expect(event.rawType).toBe("order.paid")
    expect(event.workspaceId).toBeNull()
    expect(event.customerId).toBeNull()
  })

  it("classifies a Polar provider product UUID through POLAR_LOCAL_PRODUCT_IDS as local", () => {
    envState.POLAR_LOCAL_PRODUCT_IDS = JSON.stringify({
      individual_regular: "prod_uuid_abc123",
    })

    const event = normalizeProviderEvent({
      provider: "polar",
      eventType: "order.paid",
      deliveryId: "del_polar_2",
      payload: {
        type: "order.paid",
        data: { id: "ord_POLAR_UUID", product_id: "prod_uuid_abc123" },
      },
    })

    expect(event.kind).toBe("local_purchase_paid")
    expect(event.productKind).toBe("local")
  })

  it("maps refund.created from BOTH providers to refund_completed with refundId", () => {
    const polar = normalizeProviderEvent({
      provider: "polar",
      eventType: "refund.created",
      deliveryId: "del_refund_polar",
      payload: {
        type: "refund.created",
        data: { id: "ref_P_1", order_id: "ord_P_REF", amount: 100, status: "succeeded" },
      },
    })
    const razorpay = normalizeProviderEvent({
      provider: "razorpay",
      eventType: "refund.created",
      deliveryId: "evt_refund_rzp",
      payload: {
        event: "refund.created",
        created_at: 1_755_000_000,
        payload: {
          refund: { entity: { id: "rfnd_R_1", payment_id: "pay_R_1", amount: 100 } },
          payment: { entity: { id: "pay_R_1", order_id: "order_R_REF", notes: {} } },
        },
      },
    })

    for (const event of [polar, razorpay]) {
      expect(event.kind).toBe("refund_completed")
      expect(event.refundId).toBeTruthy()
    }
    expect(polar.orderId).toBe("ord_P_REF")
    // Razorpay primary entity is the refund; order reference still resolved.
    expect(razorpay.refundId).toBe("rfnd_R_1")
  })

  it("distinguishes subscription first payment vs renewal via isFirstPayment meta", () => {
    const base = (isFirstPayment?: boolean) => ({
      provider: "razorpay" as const,
      eventType: "subscription.charged",
      deliveryId: `del_${String(isFirstPayment)}`,
      payload: {
        event: "subscription.charged",
        created_at: 1_755_000_000,
        payload: {
          subscription: { entity: { id: "sub_S1", plan_id: "plan_1", status: "active" } },
          payment: {
            entity: {
              id: "pay_S1",
              notes: isFirstPayment === undefined ? {} : { isFirstPayment },
            },
          },
        },
      },
    })

    const first = normalizeProviderEvent(base(true))
    const renewed = normalizeProviderEvent(base(false))

    expect(first.kind).toBe("subscription_paid")
    expect(first.productKind).toBe("subscription")
    expect(renewed.kind).toBe("subscription_renewed")
    expect(renewed.subscriptionId).toBe("sub_S1")
  })

  it("classifies minute packs as productKind 'minute_pack' and one-time paid shape", () => {
    const event = normalizeProviderEvent({
      provider: "polar",
      eventType: "order.paid",
      deliveryId: "del_pack_1",
      payload: {
        type: "order.paid",
        data: { id: "ord_PACK_1", metadata: { packId: "pack_100" } },
      },
    })

    expect(event.kind).toBe("local_purchase_paid")
    expect(event.productKind).toBe("minute_pack")
  })

  it("maps lifecycle events to entitlement_transitioned", () => {
    const event: NormalizedBillingEvent = normalizeProviderEvent({
      provider: "razorpay",
      eventType: "subscription.cancelled",
      deliveryId: "del_cancel_1",
      payload: {
        event: "subscription.cancelled",
        created_at: 1_755_000_000,
        payload: { subscription: { entity: { id: "sub_C1" } } },
      },
    })

    expect(event.kind).toBe("entitlement_transitioned")
    expect(event.subscriptionId).toBe("sub_C1")
  })
})
