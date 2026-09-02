import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/config", () => ({ env: {} }))

// Mock prisma before importing the module under test. clawback.ts uses
// `new Prisma.Decimal(...)` at runtime, so the mock must expose a Decimal
// constructor. This minimal stand-in supports the methods clawback uses
// (gt, minus, lte, toString).
vi.mock("@lyrashield/db", () => {
  class FakeDecimal {
    private n: number
    constructor(v: string | number | { toString: () => string }) {
      this.n =
        typeof v === "string"
          ? Number.parseFloat(v)
          : typeof v === "number"
            ? v
            : Number.parseFloat(String(v))
    }
    toString() {
      return Number.isInteger(this.n) ? `${this.n}` : `${this.n}`
    }
    minus(other: { toString: () => string }) {
      return new FakeDecimal(this.n - Number.parseFloat(String(other)))
    }
    gt(other: { toString: () => string }) {
      return this.n > Number.parseFloat(String(other))
    }
    lte(other: { toString: () => string }) {
      return this.n <= Number.parseFloat(String(other))
    }
    equals(other: { toString: () => string }) {
      return this.n === Number.parseFloat(String(other))
    }
    plus(other: { toString: () => string }) {
      return new FakeDecimal(this.n + Number.parseFloat(String(other)))
    }
  }
  return {
    Prisma: { Decimal: FakeDecimal },
    prisma: {
      conversion: {
        findFirst: vi.fn(),
      },
      commission: {
        update: vi.fn(),
      },
      affiliate: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    },
  }
})

vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { onRefund } from "./clawback"
import { prisma } from "@lyrashield/db"

const REVERSED_COMMISSION = {
  id: "comm-1",
  amount: { minus: () => ({ lte: () => false }), gt: () => false, toString: () => "50.0000" },
  status: "REVERSED",
}

describe("clawback — RISK-C3 replay guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("skips the activeReferrals decrement on a replayed refund (commission already REVERSED)", async () => {
    // The conversion's commission is already REVERSED — this is a replayed
    // webhook. The guard must return early WITHOUT decrementing activeReferrals.
    vi.mocked(prisma.conversion.findFirst).mockResolvedValue({
      id: "conv-1",
      idempotencyKey: "polar:order-123",
      subscriptionId: "sub-1",
      affiliateId: "aff-1",
      grossAmount: { toString: () => "50.0000" },
      currency: "USD",
      commissions: [REVERSED_COMMISSION],
    })

    const result = await onRefund({
      provider: "polar",
      externalId: "order-123",
      refundAmount: "50.0000",
      currency: "USD",
      reason: "REFUND",
    })

    expect(result.reversed).toBe(true)
    expect(result.replay).toBe(true)
    // Critical: the commission update (reversal write) must NOT be called on replay
    expect(prisma.commission.update).not.toHaveBeenCalled()
    // Critical: the affiliate activeReferrals decrement must NOT happen on replay
    expect(prisma.affiliate.findUnique).not.toHaveBeenCalled()
    expect(prisma.affiliate.update).not.toHaveBeenCalled()
  })

  it("keeps chargeback replay idempotent without refund-only money evidence", async () => {
    vi.mocked(prisma.conversion.findFirst).mockResolvedValue({
      id: "conv-chargeback",
      idempotencyKey: "polar:order-chargeback",
      subscriptionId: "sub-chargeback",
      affiliateId: "aff-chargeback",
      grossAmount: { toString: () => "50.0000" },
      currency: "USD",
      commissions: [REVERSED_COMMISSION],
    })

    const result = await onRefund({
      provider: "polar",
      externalId: "order-chargeback",
      reason: "CHARGEBACK",
      isChargeback: true,
    })

    expect(result).toEqual(expect.objectContaining({ reversed: true, replay: true }))
    expect(prisma.commission.update).not.toHaveBeenCalled()
    expect(prisma.affiliate.update).not.toHaveBeenCalled()
  })

  it("decrements activeReferrals on a genuine first-time refund (commission PENDING/AVAILABLE/PAID)", async () => {
    const activeCommission = {
      id: "comm-2",
      amount: {
        minus: () => ({ lte: () => false }),
        gt: () => false,
        toString: () => "50.0000",
      },
      status: "PAID",
    }
    vi.mocked(prisma.conversion.findFirst).mockResolvedValue({
      id: "conv-2",
      idempotencyKey: "polar:order-456",
      subscriptionId: "sub-2",
      affiliateId: "aff-2",
      grossAmount: { toString: () => "50.0000" },
      currency: "USD",
      commissions: [activeCommission],
    })
    vi.mocked(prisma.affiliate.findUnique).mockResolvedValue({ activeReferrals: 5 })
    vi.mocked(prisma.commission.update).mockResolvedValue(undefined)
    vi.mocked(prisma.affiliate.update).mockResolvedValue(undefined)

    const result = await onRefund({
      provider: "polar",
      externalId: "order-456",
      refundAmount: "50.0000",
      currency: "USD",
      reason: "REFUND",
    })

    expect(result.reversed).toBe(true)
    expect(result.replay).toBeUndefined()
    // The reversal write happened
    expect(prisma.commission.update).toHaveBeenCalledOnce()
    // The activeReferrals decrement happened (first-time refund)
    expect(prisma.affiliate.update).toHaveBeenCalledOnce()
  })

  it("routes a refund money mismatch to manual review instead of throwing", async () => {
    vi.mocked(prisma.conversion.findFirst).mockResolvedValue({
      id: "conv-3",
      idempotencyKey: "razorpay:pay-789",
      subscriptionId: null,
      affiliateId: "aff-3",
      grossAmount: { toString: () => "50.0000" },
      currency: "INR",
      commissions: [
        {
          id: "comm-3",
          amount: { gt: () => false, toString: () => "10.0000" },
          status: "PENDING",
        },
      ],
    })

    // A mismatch (partial refund, rounding drift, or currency disagreement) is
    // a reconciliation question for a human — never a thrown error that would
    // exhaust webhook retries and silently drop the clawback, and never a
    // silent pass that leaves the commission standing on a refunded order.
    for (const evidence of [
      { refundAmount: "49.0000", currency: "INR" },
      { refundAmount: "50.0000", currency: "USD" },
      { refundAmount: undefined, currency: undefined },
    ]) {
      const result = await onRefund({
        provider: "razorpay",
        externalId: "pay-789",
        reason: "REFUND",
        ...evidence,
      })
      expect(result.reversed).toBe(false)
      expect(result.manualReview).toBe(true)
    }
    expect(prisma.commission.update).not.toHaveBeenCalled()
  })
})
