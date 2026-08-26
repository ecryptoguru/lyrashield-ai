import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock @lyrashield/db. reserve-release.ts uses `new Prisma.Decimal(...)` at
// runtime, so the mock must expose a Decimal constructor. vi.mock factories are
// hoisted above all module-scope declarations, so anything the factory
// references (FakeDecimal, models, runTransaction) MUST be defined with
// vi.hoisted() — plain module-scope `class`/`const` are NOT initialized when
// the hoisted factory runs (that caused "Cannot access 'FakeDecimal' before
// initialization").
const { FakeDecimal, models, runTransaction } = vi.hoisted(() => {
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
      return Number.isInteger(this.n) ? `${this.n}.0000` : `${this.n}`
    }
    minus(other: { toString: () => string }) {
      return new FakeDecimal(this.n - Number.parseFloat(String(other)))
    }
    lte(other: { toString: () => string }) {
      return this.n <= Number.parseFloat(String(other))
    }
    gt(other: { toString: () => string }) {
      return this.n > Number.parseFloat(String(other))
    }
    plus(other: { toString: () => string }) {
      return new FakeDecimal(this.n + Number.parseFloat(String(other)))
    }
    mul(other: { toString: () => string }) {
      return new FakeDecimal(this.n * Number.parseFloat(String(other)))
    }
    div(other: { toString: () => string }) {
      return new FakeDecimal(this.n / Number.parseFloat(String(other)))
    }
    add(other: { toString: () => string }) {
      return this.plus(other)
    }
    equals(other: { toString: () => string }) {
      return Math.abs(this.n - Number.parseFloat(String(other))) < 1e-9
    }
    toDecimalPlaces(places: number) {
      const scale = 10 ** places
      return new FakeDecimal(Math.round(this.n * scale) / scale)
    }
  }

  const models = {
    affiliate: { findUnique: vi.fn(), findMany: vi.fn() },
    commission: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // workspaceMember.findFirst is used to resolve the affiliate's owning
    // workspace for the audit log (added in the FK-fix). Default to no
    // membership (returns undefined) so the audit-write is skipped in tests.
    workspaceMember: { findFirst: vi.fn().mockResolvedValue(null) },
    // payout.create must resolve to an object with an `id` (the code reads
    // payout.id for the payoutItem and auditLog references).
    payout: { create: vi.fn().mockResolvedValue({ id: "payout-test-id" }) },
    payoutItem: { create: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: vi.fn().mockResolvedValue(undefined) },
  }

  const runTransaction = (cb: (tx: unknown) => Promise<unknown>) => cb(models)

  return { FakeDecimal, models, runTransaction }
})

vi.mock("@lyrashield/db", () => {
  return {
    Prisma: { Decimal: Object.assign(FakeDecimal, { ROUND_HALF_UP: 4 }) },
    prisma: {
      ...models,
      $transaction: vi.fn(runTransaction),
    },
  }
})

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { releaseReserveForAffiliate } from "./reserve-release"
import { prisma } from "@lyrashield/db"
import { Prisma } from "@lyrashield/db"

// Helper: a fake commission with a FakeDecimal amount and a payoutItems array.
function fakeCommission(opts: {
  id: string
  amount: string
  paidAmount: string
  status?: string
  reserveReleasedAt?: Date | null
}) {
  const amount = new Prisma.Decimal(opts.amount)
  const paidAmount = new Prisma.Decimal(opts.paidAmount)
  return {
    id: opts.id,
    amount,
    currency: "USD",
    status: opts.status ?? "PAID",
    reserveReleasedAt: opts.reserveReleasedAt ?? null,
    payoutItems: [{ amount: paidAmount }],
  }
}

describe("reserve-release — RISK-C7 hold/release math + idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.$transaction).mockImplementation(runTransaction)
    // clearAllMocks strips the factory's resolved values — re-set them so the
    // transaction writes resolve correctly.
    vi.mocked(models.payout.create).mockResolvedValue({ id: "payout-test-id" })
    vi.mocked(models.payoutItem.create).mockResolvedValue({} as never)
    vi.mocked(models.payoutItem.deleteMany).mockResolvedValue({ count: 0 } as never)
    vi.mocked(models.commission.update).mockResolvedValue({} as never)
    vi.mocked(models.commission.updateMany).mockResolvedValue({ count: 1 } as never)
    vi.mocked(models.auditLog.create).mockResolvedValue(undefined)
    vi.mocked(models.workspaceMember.findFirst).mockResolvedValue(null)
  })

  it("releases nothing when the reserve is still active (reserveUntil in the future)", async () => {
    vi.mocked(prisma.affiliate.findUnique).mockResolvedValue({
      id: "aff-1",
      reserveUntil: new Date(Date.now() + 30 * 86400_000), // 30 days from now
      reservePct: 25,
    })

    const result = await releaseReserveForAffiliate("aff-1")

    expect(result.released).toBe(0)
    expect(prisma.commission.findMany).not.toHaveBeenCalled()
  })

  it("releases the reserved delta for each PAID commission past the reserve window", async () => {
    vi.mocked(prisma.affiliate.findUnique).mockResolvedValue({
      id: "aff-2",
      reserveUntil: new Date(Date.now() - 86400_000), // expired yesterday
      reservePct: 25,
    })
    // Two commissions: full $40, paid $30 -> reserved delta $10
    //                  full $100, paid $75 -> reserved delta $25
    vi.mocked(prisma.commission.findMany).mockResolvedValue([
      fakeCommission({ id: "c1", amount: "40.0000", paidAmount: "30.0000" }),
      fakeCommission({ id: "c2", amount: "100.0000", paidAmount: "75.0000" }),
    ])

    const result = await releaseReserveForAffiliate("aff-2")

    expect(result.released).toBe(2)
    expect(result.totalAmount.toString()).toBe("35.0000") // 10 + 25
    expect(result.currency).toBe("USD")
    // A reserve-release payout was created
    expect(prisma.payout.create).toHaveBeenCalledOnce()
    // Two payout items (one per commission)
    expect(prisma.payoutItem.create).toHaveBeenCalledTimes(2)
    // Each commission was marked reserveReleasedAt (updateMany with CAS)
    const updateCalls = (prisma.commission.updateMany as unknown as ReturnType<typeof vi.fn>).mock
      .calls.length
    const legacyUpdateCalls = (prisma.commission.update as unknown as ReturnType<typeof vi.fn>).mock
      .calls.length
    expect(updateCalls + legacyUpdateCalls).toBe(2)
  })

  it("is idempotent — commissions already released (reserveReleasedAt set) are filtered out", async () => {
    vi.mocked(prisma.affiliate.findUnique).mockResolvedValue({
      id: "aff-3",
      reserveUntil: new Date(Date.now() - 86400_000),
      reservePct: 25,
    })
    // All commissions already released -> findMany returns [] (the where clause
    // filters reserveReleasedAt: null)
    vi.mocked(prisma.commission.findMany).mockResolvedValue([])

    const result = await releaseReserveForAffiliate("aff-3")

    expect(result.released).toBe(0)
    expect(prisma.payout.create).not.toHaveBeenCalled()
  })

  it("marks zero-reserve commissions as released so they are not reconsidered", async () => {
    vi.mocked(prisma.affiliate.findUnique).mockResolvedValue({
      id: "aff-4",
      reserveUntil: new Date(Date.now() - 86400_000),
      reservePct: 25,
    })
    // Commission paid in full (no reserve held) -> delta 0, but still marked released
    vi.mocked(prisma.commission.findMany).mockResolvedValue([
      fakeCommission({ id: "c3", amount: "50.0000", paidAmount: "50.0000" }),
    ])

    const result = await releaseReserveForAffiliate("aff-4")

    expect(result.released).toBe(1)
    expect(result.totalAmount.toString()).toBe("0.0000") // nothing to pay
    const updCalls = (prisma.commission.updateMany as unknown as ReturnType<typeof vi.fn>).mock
      .calls.length
    const legCalls = (prisma.commission.update as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length
    expect(updCalls + legCalls).toBe(1)
  })

  it("rounds reserve-release legs to provider minor units", async () => {
    vi.mocked(prisma.commission.findMany).mockResolvedValue([
      fakeCommission({ id: "c4", amount: "100.1234", paidAmount: "75.0000" }),
    ])

    const result = await releaseReserveForAffiliate("aff-2")

    expect(result.totalAmount.toString()).toBe("25.12")
    expect(prisma.payoutItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: expect.objectContaining({}) }),
    })
    const amount = vi.mocked(prisma.payoutItem.create).mock.calls[0]?.[0].data.amount
    expect(amount.toString()).toBe("25.12")
  })
})
