import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/affiliate", () => ({
  releaseReserve: vi.fn(),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { processAffiliateReserveReleaseJob } from "./affiliate-reserve-release.job"
import { releaseReserve } from "@lyrashield/affiliate"

describe("affiliate-reserve-release.job", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should release reserve and return counts", async () => {
    vi.mocked(releaseReserve).mockResolvedValue({
      affiliatesReleased: 3,
      commissionsReleased: 12,
      totals: { USD: "240.0000" },
    })

    const result = await processAffiliateReserveReleaseJob({
      scheduledAt: new Date().toISOString(),
    })

    expect(result.affiliatesReleased).toBe(3)
    expect(result.commissionsReleased).toBe(12)
    expect(releaseReserve).toHaveBeenCalledOnce()
  })

  it("should handle zero releases", async () => {
    vi.mocked(releaseReserve).mockResolvedValue({
      affiliatesReleased: 0,
      commissionsReleased: 0,
      totals: {},
    })

    const result = await processAffiliateReserveReleaseJob({
      scheduledAt: new Date().toISOString(),
    })

    expect(result.affiliatesReleased).toBe(0)
    expect(result.commissionsReleased).toBe(0)
  })

  it("should propagate errors from releaseReserve", async () => {
    vi.mocked(releaseReserve).mockRejectedValue(new Error("DB error"))

    await expect(
      processAffiliateReserveReleaseJob({ scheduledAt: new Date().toISOString() })
    ).rejects.toThrow("DB error")
  })
})
