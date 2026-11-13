import { beforeEach, describe, expect, it, vi } from "vitest"

const { db, tx, send } = vi.hoisted(() => {
  const tx = {
    payout: { updateMany: vi.fn() },
    payoutItem: { findMany: vi.fn() },
    commission: { updateMany: vi.fn() },
  }
  return {
    tx,
    send: vi.fn(),
    db: {
      affiliate: { findMany: vi.fn() },
      payout: { findMany: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn((callback) => callback(tx)),
    },
  }
})

vi.mock("@lyrashield/db", () => ({ prisma: db }))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn() } }))
vi.mock("@lyrashield/config", () => ({ env: { RAZORPAYX_PAYOUT_ADMISSION: "public" } }))
vi.mock("../constants", () => ({ PAYOUT_DAY_OF_MONTH: 15 }))
vi.mock("./eligibility", () => ({ checkPayoutEligibility: vi.fn() }))
vi.mock("./request", () => ({ requestPayout: vi.fn() }))
vi.mock("./providers/razorpayx", () => ({
  createRazorpayXProvider: () => ({ send }),
}))

import { payoutScheduler } from "./scheduler"

describe("payoutScheduler reserve release rejection", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"))
    vi.clearAllMocks()
    db.affiliate.findMany.mockResolvedValue([])
    db.payout.findMany.mockResolvedValue([
      {
        id: "reserve-payout-1",
        affiliateId: "affiliate-1",
        idempotencyKey: "test",
        amount: { toString: () => "25.00" },
        currency: "INR",
        affiliate: { payoutMethod: { type: "razorpayx", fundAccountId: "fa_1" } },
      },
    ])
    db.payout.updateMany.mockResolvedValue({ count: 1 })
    tx.payout.updateMany.mockResolvedValue({ count: 1 })
    tx.payoutItem.findMany.mockResolvedValue([{ commissionId: "commission-1" }])
    tx.commission.updateMany.mockResolvedValue({ count: 1 })
    send.mockResolvedValue({ success: false, rejected: true })
  })

  it("reopens the reserve claim only after winning the failed-status CAS", async () => {
    await payoutScheduler()

    expect(tx.payout.updateMany).toHaveBeenCalledWith({
      where: { id: "reserve-payout-1", status: "PROCESSING" },
      data: { status: "FAILED", failureCode: "PROVIDER_REJECTED" },
    })
    expect(tx.payoutItem.findMany).toHaveBeenCalledWith({
      where: { payoutId: "reserve-payout-1", isReserveRelease: true },
      select: { commissionId: true },
    })
    expect(tx.commission.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["commission-1"] },
        status: "PAID",
        reserveReleasedAt: { not: null },
      },
      data: { reserveReleasedAt: null, reserveReleasedAmount: null },
    })
  })

  it("does not reopen claims if another actor already finalized the payout", async () => {
    tx.payout.updateMany.mockResolvedValue({ count: 0 })

    await payoutScheduler()

    expect(tx.commission.updateMany).not.toHaveBeenCalled()
  })
})
