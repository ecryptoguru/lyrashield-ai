import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/affiliate", () => ({
  releaseCommissions: vi.fn(),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { processAffiliateReleaseJob } from "./affiliate-release-commissions.job"
import { releaseCommissions } from "@lyrashield/affiliate"

describe("affiliate-release-commissions.job", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should release commissions and return count", async () => {
    vi.mocked(releaseCommissions).mockResolvedValue({
      released: 5,
      commissionIds: ["c1", "c2", "c3", "c4", "c5"],
    })

    const result = await processAffiliateReleaseJob({
      scheduledAt: new Date().toISOString(),
    })

    expect(result.released).toBe(5)
    expect(releaseCommissions).toHaveBeenCalledOnce()
  })

  it("should handle zero releases", async () => {
    vi.mocked(releaseCommissions).mockResolvedValue({
      released: 0,
      commissionIds: [],
    })

    const result = await processAffiliateReleaseJob({
      scheduledAt: new Date().toISOString(),
    })

    expect(result.released).toBe(0)
  })

  it("should propagate errors from releaseCommissions", async () => {
    vi.mocked(releaseCommissions).mockRejectedValue(new Error("DB error"))

    await expect(
      processAffiliateReleaseJob({ scheduledAt: new Date().toISOString() })
    ).rejects.toThrow("DB error")
  })
})
