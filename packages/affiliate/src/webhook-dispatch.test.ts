import { beforeEach, describe, expect, it, vi } from "vitest"

const onOrderPaidMock = vi.fn().mockResolvedValue({ commissionId: "c_1" })
const onRefundMock = vi.fn().mockResolvedValue({ reversed: true })
const onLocalOrderPaidMock = vi.fn().mockResolvedValue({ commissionId: "lc_1" })

vi.mock("./commission/engine", () => ({
  onOrderPaid: (...args: unknown[]) => onOrderPaidMock(...args),
}))
vi.mock("./commission/clawback", () => ({
  onRefund: (...args: unknown[]) => onRefundMock(...args),
}))
vi.mock("./commission/local", () => ({
  onLocalOrderPaid: (...args: unknown[]) => onLocalOrderPaidMock(...args),
}))
vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { dispatch } from "./webhook-dispatch"

beforeEach(() => {
  onOrderPaidMock.mockClear().mockResolvedValue({ commissionId: "c_1" })
  onRefundMock.mockClear().mockResolvedValue({ reversed: true })
  onLocalOrderPaidMock.mockClear().mockResolvedValue({ commissionId: "lc_1" })
})

describe("affiliate webhook-dispatch — normalized event fan-out", () => {
  it("e) refund.completed kind fires clawback exactly once with refundId propagated", async () => {
    const result = await dispatch({
      provider: "razorpay",
      kind: "refund_completed",
      rawType: "refund.created",
      productKind: "unknown",
      refundId: "rfnd_R_77",
      money: {
        currency: "INR",
        grossAmount: "49.0000",
        discountAmount: "0.0000",
        taxAmount: "0.0000",
        commissionableAmount: "49.0000",
      },
      metadata: {},
      entity: {
        id: "rfnd_R_77",
        payment_id: "pay_R_9",
        order_id: "order_R_9",
        amount: 4900,
      },
    })

    expect(result.handled).toBe(true)
    expect(onRefundMock).toHaveBeenCalledTimes(1)
    expect(onRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "razorpay",
        externalId: "order_R_9",
        refundId: "rfnd_R_77",
        reason: "REFUND",
      })
    )
    expect(onOrderPaidMock).not.toHaveBeenCalled()
  })

  it("chargeback.created raw type maps to CHARGEBACK reason", async () => {
    await dispatch({
      provider: "polar",
      kind: "refund_completed",
      rawType: "chargeback.created",
      productKind: "unknown",
      refundId: "ref_C_1",
      money: {
        currency: "USD",
        grossAmount: "0.0000",
        discountAmount: "0.0000",
        taxAmount: "0.0000",
        commissionableAmount: "0.0000",
      },
      metadata: {},
      entity: { id: "ref_C_1", order_id: "ord_C_1" },
    })

    expect(onRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "CHARGEBACK", isChargeback: true })
    )
  })

  it("f) minute-pack paid event creates NO commission", async () => {
    const result = await dispatch({
      provider: "polar",
      kind: "local_purchase_paid",
      rawType: "order.paid",
      productKind: "minute_pack",
      money: null,
      metadata: {},
      entity: { id: "ord_PACK", productId: "polar_pack_250" },
    })

    // C2: skipped explicitly — never routed to a commission handler.
    expect(result.handled).toBe(true)
    expect(result.result).toEqual({ skipped: "minute_pack_no_commission" })
    expect(onOrderPaidMock).not.toHaveBeenCalled()
    expect(onLocalOrderPaidMock).not.toHaveBeenCalled()
    expect(onRefundMock).not.toHaveBeenCalled()
  })

  it("minute-pack exclusion also holds via structural detection when productKind disagrees", async () => {
    // Defense in depth: even if the normalizer mislabels, the structural
    // predicate still skips commissions.
    await dispatch({
      provider: "razorpay",
      kind: "subscription_paid",
      rawType: "payment.captured",
      productKind: "unknown",
      money: null,
      metadata: {},
      entity: { id: "pay_PACK", notes: { packId: "pack_100" } },
    })

    expect(onOrderPaidMock).not.toHaveBeenCalled()
    expect(onLocalOrderPaidMock).not.toHaveBeenCalled()
  })

  it("local purchase routes to the local commission handler", async () => {
    await dispatch({
      provider: "polar",
      kind: "local_purchase_paid",
      rawType: "order.paid",
      productKind: "local",
      money: {
        currency: "USD",
        grossAmount: "299.0000",
        discountAmount: "0.0000",
        taxAmount: "0.0000",
        commissionableAmount: "299.0000",
      },
      metadata: { affiliate_id: "aff_local", click_id: "click_local" },
      entity: {
        id: "ord_LOCAL",
        productId: "individual_regular",
        customerEmail: "buyer@example.com",
        amount: "299",
      },
    })

    expect(onLocalOrderPaidMock).toHaveBeenCalledTimes(1)
    expect(onLocalOrderPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ affiliateId: "aff_local", clickId: "click_local" })
    )
    expect(onOrderPaidMock).not.toHaveBeenCalled()
  })

  it("cloud subscription paid routes to the recurring commission engine", async () => {
    await dispatch({
      provider: "polar",
      kind: "subscription_paid",
      rawType: "order.paid",
      productKind: "subscription",
      money: {
        currency: "USD",
        grossAmount: "49.0000",
        discountAmount: "0.0000",
        taxAmount: "0.0000",
        commissionableAmount: "49.0000",
      },
      metadata: { affToken: "tok123" },
      entity: {
        id: "ord_SUB",
        subscriptionId: "sub_Z",
        customerId: "cus_1",
        customerEmail: "sub@example.com",
        amount: "49",
        metadata: { affToken: "tok123" },
      },
    })

    expect(onOrderPaidMock).toHaveBeenCalledTimes(1)
    expect(onOrderPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "polar",
        externalId: "ord_SUB",
        cookieToken: "tok123",
        grossAmount: "49.0000",
      })
    )
    expect(onLocalOrderPaidMock).not.toHaveBeenCalled()
  })

  it("entitlement transitions carry no commission relevance", async () => {
    const result = await dispatch({
      provider: "razorpay",
      kind: "entitlement_transitioned",
      rawType: "subscription.cancelled",
      productKind: "subscription",
      money: null,
      metadata: {},
      entity: { id: "sub_C" },
    })

    expect(result.handled).toBe(false)
    expect(onOrderPaidMock).not.toHaveBeenCalled()
    expect(onRefundMock).not.toHaveBeenCalled()
  })

  it("handler errors propagate — silent catches die (caller owns retry semantics)", async () => {
    onRefundMock.mockRejectedValue(new Error("db down"))
    await expect(
      dispatch({
        provider: "polar",
        kind: "refund_completed",
        rawType: "refund.created",
        productKind: "unknown",
        refundId: "r1",
        money: {
          currency: "USD",
          grossAmount: "1.0000",
          discountAmount: "0.0000",
          taxAmount: "0.0000",
          commissionableAmount: "1.0000",
        },
        metadata: {},
        entity: { id: "r1", order_id: "o1" },
      })
    ).rejects.toThrow("db down")
  })

  it("fails the affiliate track when paid money evidence is unavailable", async () => {
    await expect(
      dispatch({
        provider: "razorpay",
        kind: "subscription_renewed",
        rawType: "subscription.charged",
        productKind: "subscription",
        money: null,
        metadata: {},
        entity: { id: "pay_missing_money" },
      })
    ).rejects.toThrow("affiliate_money_evidence_unavailable")
    expect(onOrderPaidMock).not.toHaveBeenCalled()
  })
})
