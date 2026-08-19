import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/affiliate", () => ({
  expireAttributionTokens: vi.fn(),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { processAffiliateExpireTokensJob } from "./affiliate-expire-tokens.job"
import { expireAttributionTokens } from "@lyrashield/affiliate"

describe("affiliate-expire-tokens.job", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should expire tokens and return count", async () => {
    vi.mocked(expireAttributionTokens).mockResolvedValue({ deleted: 10 })

    const result = await processAffiliateExpireTokensJob({
      scheduledAt: new Date().toISOString(),
    })

    expect(result.deleted).toBe(10)
    expect(expireAttributionTokens).toHaveBeenCalledOnce()
  })

  it("should handle zero deletions", async () => {
    vi.mocked(expireAttributionTokens).mockResolvedValue({ deleted: 0 })

    const result = await processAffiliateExpireTokensJob({
      scheduledAt: new Date().toISOString(),
    })

    expect(result.deleted).toBe(0)
  })

  it("should propagate errors", async () => {
    vi.mocked(expireAttributionTokens).mockRejectedValue(new Error("DB error"))

    await expect(
      processAffiliateExpireTokensJob({ scheduledAt: new Date().toISOString() })
    ).rejects.toThrow("DB error")
  })
})
