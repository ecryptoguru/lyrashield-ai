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
      { id: "commission-1", amount: new FakeDecimal("125"), currency: "USD" },
    ])
    vi.mocked(prisma.commission.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.payout.create).mockResolvedValue({ id: "payout-1" })
    vi.mocked(prisma.payout.updateMany).mockResolvedValue({ count: 1 })
    vi.mocked(prisma.payoutItem.create).mockResolvedValue({})
  })

  it("keeps captured commissions reserved when provider outcome is ambiguous", async () => {
    const result = await requestPayout({
      affiliateId: "affiliate-1",
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
})
