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
          currency: "usd",
          total_amount: 19900,
          discount_amount: 0,
          tax_amount: 0,
          net_amount: 19900,
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
    expect(event.money).toEqual({
      currency: "USD",
      grossAmount: "199.0000",
      discountAmount: "0.0000",
      taxAmount: "0.0000",
      commissionableAmount: "199.0000",
    })
  })

  it("rejects inconsistent Polar total, tax, and commissionable evidence", () => {
    const event = normalizeProviderEvent({
      provider: "polar",
      eventType: "order.paid",
      deliveryId: "del_polar_bad_money",
      payload: {
        type: "order.paid",
        data: {
          id: "ord_bad",
          currency: "USD",
          total_amount: 19900,
          discount_amount: 0,
          tax_amount: 100,
          net_amount: 19900,
        },
      },
    })

    expect(event.money).toBeNull()
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
        data: {
          id: "ref_P_1",
          order_id: "ord_P_REF",
          amount: 100,
          currency: "USD",
          status: "succeeded",
        },
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
          refund: {
            entity: { id: "rfnd_R_1", payment_id: "pay_R_1", amount: 100, currency: "INR" },
          },
          payment: {
            entity: {
              id: "pay_R_1",
              order_id: "order_R_REF",
              amount: 100,
              currency: "INR",
              notes: {},
            },
          },
        },
      },
    })

    for (const event of [polar, razorpay]) {
      expect(event.kind).toBe("refund_completed")
      expect(event.refundId).toBeTruthy()
      expect(event.money?.grossAmount).toBe("1.0000")
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
              amount: 290000,
              currency: "INR",
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
    expect(first.money).toEqual({
      currency: "INR",
      grossAmount: "2900.0000",
      discountAmount: "0.0000",
      taxAmount: "442.3729",
      commissionableAmount: "2457.6271",
    })
  })

  it("normalizes payment_link.paid from paise and merges payment-link notes", () => {
    const event = normalizeProviderEvent({
      provider: "razorpay",
      eventType: "payment_link.paid",
      deliveryId: "evt_link_1",
      payload: {
        event: "payment_link.paid",
        created_at: 1_755_000_000,
        payload: {
          payment: {
            entity: {
              id: "pay_LOCAL_1",
              amount: 1_990_000,
              currency: "INR",
              notes: { click_id: "click_1" },
            },
          },
          payment_link: {
            entity: {
              id: "plink_1",
              reference_id: "local_ref_1",
              notes: { productId: "individual_launch", affiliate_id: "aff_1" },
            },
          },
        },
      },
    })

    expect(event.kind).toBe("local_purchase_paid")
    expect(event.productKind).toBe("local")
    expect(event.paymentId).toBe("pay_LOCAL_1")
    expect(event.metadata).toEqual(
      expect.objectContaining({
        productId: "individual_launch",
        affiliate_id: "aff_1",
        click_id: "click_1",
      })
    )
    expect(event.money?.commissionableAmount).toBe("16864.4068")
  })

  it("does not guess money when amount evidence or currency is invalid", () => {
    for (const entity of [
      { id: "pay_missing", currency: "INR" },
      { id: "pay_unknown", amount: 100, currency: "BTC" },
      { id: "pay_decimal", amount: 1.5, currency: "INR" },
    ]) {
      const event = normalizeProviderEvent({
        provider: "razorpay",
        eventType: "payment.captured",
        deliveryId: `evt_${entity.id}`,
        payload: { event: "payment.captured", payload: { payment: { entity } } },
      })
      expect(event.money).toBeNull()
    }
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
