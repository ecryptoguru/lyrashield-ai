import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/affiliate", () => ({
  payoutScheduler: vi.fn(),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { processAffiliatePayoutSchedulerJob } from "./affiliate-payout-scheduler.job"
import { payoutScheduler } from "@lyrashield/affiliate"

describe("affiliate-payout-scheduler.job", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should process payouts and return counts", async () => {
    vi.mocked(payoutScheduler).mockResolvedValue([
      { affiliateId: "a1", payoutId: "p1", amount: "150.00", success: true },
      { affiliateId: "a2", payoutId: "p2", amount: "200.00", success: true },
      { affiliateId: "a3", success: false, error: "Below minimum" },
    ])

    const result = await processAffiliatePayoutSchedulerJob({
      scheduledAt: new Date().toISOString(),
    })

    expect(result.totalAffiliates).toBe(3)
    expect(result.successful).toBe(2)
    expect(result.failed).toBe(1)
    expect(payoutScheduler).toHaveBeenCalledOnce()
  })

  it("should handle empty batches", async () => {
    vi.mocked(payoutScheduler).mockResolvedValue([])

    const result = await processAffiliatePayoutSchedulerJob({
      scheduledAt: new Date().toISOString(),
    })

    expect(result.totalAffiliates).toBe(0)
    expect(result.successful).toBe(0)
    expect(result.failed).toBe(0)
  })

  it("should propagate errors", async () => {
    vi.mocked(payoutScheduler).mockRejectedValue(new Error("Scheduler error"))

    await expect(
      processAffiliatePayoutSchedulerJob({ scheduledAt: new Date().toISOString() })
    ).rejects.toThrow("Scheduler error")
  })
})
