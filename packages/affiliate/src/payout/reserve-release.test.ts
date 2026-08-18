import { describe, it, expect, vi, beforeEach } from "vitest"
import { Prisma } from "@lyrashield/db"

// Mock @lyrashield/db but keep the real Prisma namespace (for Decimal math) —
// only the `prisma` client is mocked. This avoids a fragile hand-rolled
// Decimal stand-in while still isolating the DB.
vi.mock("@lyrashield/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lyrashield/db")>()
  return {
    ...actual,
    prisma: {
      affiliate: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      commission: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
      payout: {
        create: vi.fn(),
      },
      payoutItem: {
        create: vi.fn(),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue(undefined),
      },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    },
  }
})

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { releaseReserveForAffiliate } from "./reserve-release"
import { prisma } from "@lyrashield/db"

// Helper: a fake commission with a real Prisma.Decimal amount and a payoutItems
// array (the relation is now one-to-many).
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
    vi.mocked(prisma.$transaction).mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb({})
    )
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
    // Each commission was marked reserveReleasedAt
    expect(prisma.commission.update).toHaveBeenCalledTimes(2)
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
    expect(result.totalAmount.toString()).toBe("0") // nothing to pay
    expect(prisma.commission.update).toHaveBeenCalledOnce()
  })
})
