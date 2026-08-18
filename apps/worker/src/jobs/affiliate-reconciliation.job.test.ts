import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@lyrashield/affiliate", () => ({
  reconciliationJob: vi.fn(),
}))

vi.mock("@lyrashield/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { processAffiliateReconciliationJob } from "./affiliate-reconciliation.job"
import { reconciliationJob } from "@lyrashield/affiliate"

describe("affiliate-reconciliation.job", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("should run reconciliation and return counts", async () => {
    vi.mocked(reconciliationJob).mockResolvedValue({
      conversionsChecked: 50,
      payoutsChecked: 5,
      driftItems: [],
    })

    const result = await processAffiliateReconciliationJob({
      scheduledAt: new Date().toISOString(),
    })

    expect(result.conversionsChecked).toBe(50)
    expect(result.payoutsChecked).toBe(5)
    expect(result.driftCount).toBe(0)
    expect(reconciliationJob).toHaveBeenCalledOnce()
  })

  it("should report drift items", async () => {
    vi.mocked(reconciliationJob).mockResolvedValue({
      conversionsChecked: 100,
      payoutsChecked: 10,
      driftItems: [
        {
          type: "conversion",
          internalId: "c1",
          externalId: "ext1",
          issue: "Mismatch",
        },
      ],
    })

    const result = await processAffiliateReconciliationJob({
      scheduledAt: new Date().toISOString(),
    })

    expect(result.driftCount).toBe(1)
  })

  it("should propagate errors", async () => {
    vi.mocked(reconciliationJob).mockRejectedValue(new Error("Reconciliation error"))

    await expect(
      processAffiliateReconciliationJob({ scheduledAt: new Date().toISOString() })
    ).rejects.toThrow("Reconciliation error")
  })
})
