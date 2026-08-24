import { beforeEach, describe, expect, it, vi } from "vitest"

const { FakeDecimal, models } = vi.hoisted(() => {
  class FakeDecimal {
    private readonly value: number
    constructor(value: string | number | { toString(): string }) {
      this.value = Number(value.toString())
    }
    add(other: { toString(): string }) {
      return new FakeDecimal(this.value + Number(other.toString()))
    }
    mul(other: { toString(): string }) {
      return new FakeDecimal(this.value * Number(other.toString()))
    }
    div(other: { toString(): string }) {
      return new FakeDecimal(this.value / Number(other.toString()))
    }
    toString() {
      return this.value.toFixed(4)
    }
  }
  const models = {
    affiliate: { findUnique: vi.fn() },
    commission: { findMany: vi.fn(), updateMany: vi.fn() },
    payout: { create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    payoutItem: { create: vi.fn(), deleteMany: vi.fn() },
  }
  return { FakeDecimal, models }
})

vi.mock("@lyrashield/db", () => ({
  Prisma: { Decimal: FakeDecimal },
  prisma: {
    ...models,
    $transaction: vi.fn((callback) => callback(models)),
  },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock("@lyrashield/config", () => ({
  env: { RAZORPAYX_PAYOUT_ADMISSION: "public", PAYONEER_PAYOUT_ADMISSION: "off" },
}))
vi.mock("./eligibility", () => ({
  checkPayoutEligibility: vi.fn().mockResolvedValue({ eligible: true, reasons: [] }),
}))
vi.mock("./reserve", () => ({ isReserveActive: vi.fn().mockReturnValue(false) }))

import { prisma } from "@lyrashield/db"
import { requestPayout } from "./request"

describe("requestPayout provider ambiguity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.affiliate.findUnique).mockResolvedValue({
      id: "affiliate-1",
      payoutMethod: { type: "bank" },
      reservePct: 0,
      reserveUntil: null,
    })
    vi.mocked(prisma.commission.findMany).mockResolvedValue([
      { id: "commission-1", amount: new FakeDecimal("125"), currency: "INR" },
    ])
    vi.mocked(prisma.commission.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.payout.create).mockResolvedValue({ id: "payout-1" })
    vi.mocked(prisma.payout.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.payoutItem.create).mockResolvedValue({})
  })

  it("keeps captured commissions reserved when provider outcome is ambiguous", async () => {
    const result = await requestPayout({
      affiliateId: "affiliate-1",
      provider: "razorpayx",
      sendFn: vi.fn().mockRejectedValue(new Error("timeout")),
    })

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        payoutId: "payout-1",
        error: "Payout outcome pending reconciliation",
      })
    )
    expect(prisma.payout.updateMany).toHaveBeenCalledWith({
      where: { id: "payout-1", status: "PROCESSING" },
      data: { failureCode: "PROVIDER_AMBIGUOUS" },
    })
    expect(prisma.payoutItem.deleteMany).not.toHaveBeenCalled()
    expect(prisma.commission.updateMany).toHaveBeenCalledTimes(1)
  })

  it("keeps commissions reserved while provider state is pending", async () => {
    const result = await requestPayout({
      affiliateId: "affiliate-1",
      provider: "razorpayx",
      sendFn: vi
        .fn()
        .mockResolvedValue({ success: false, pending: true, providerPayoutId: "pout_1" }),
    })
    expect(result.success).toBe(false)
    expect(prisma.payout.updateMany).toHaveBeenCalledWith({
      where: { id: "payout-1", status: "PROCESSING" },
      data: { failureCode: "PROVIDER_PENDING", providerPayoutId: "pout_1" },
    })
    expect(prisma.payoutItem.deleteMany).not.toHaveBeenCalled()
  })

  it("rejects non-INR or mixed-currency batches before reserving commissions", async () => {
    vi.mocked(prisma.commission.findMany).mockResolvedValue([
      { id: "commission-1", amount: new FakeDecimal("125"), currency: "INR" },
      { id: "commission-2", amount: new FakeDecimal("25"), currency: "USD" },
    ])

    const result = await requestPayout({
      affiliateId: "affiliate-1",
      provider: "razorpayx",
      sendFn: vi.fn(),
    })

    expect(result).toEqual({ success: false, error: "RazorpayX payouts require INR commissions" })
    expect(prisma.commission.updateMany).not.toHaveBeenCalled()
  })
})
