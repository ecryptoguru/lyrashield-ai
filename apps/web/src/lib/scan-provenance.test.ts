import { describe, expect, it } from "vitest"
import { buildScanExecutionPlan } from "@lyrashield/types"
import { publicScanProvenance, publicScanResult } from "./scan-provenance"

const plan = buildScanExecutionPlan({ targetType: "REPO", mode: "STANDARD" })

describe("public scan provenance", () => {
  it("binds only the public view so private budget guesses cannot affect its digest", () => {
    const first = publicScanProvenance(plan)
    const changed = publicScanProvenance({ ...plan, limits: { ...plan.limits, maxBudgetUsd: 7 } })
    expect(first).toEqual(changed)
    expect(first.executionPlanHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.executionPlan).not.toHaveProperty("limits.maxBudgetUsd")
  })
  it("redacts historical full receipts without rewriting their durable identity", () => {
    const receipt = { id: "scan-1", executionPlan: plan, executionPlanHash: "private-digest" }
    const replay = publicScanResult(receipt)
    expect(replay.id).toBe("scan-1")
    expect(replay.executionPlanHash).not.toBe(receipt.executionPlanHash)
    expect(replay.executionPlan).not.toHaveProperty("limits.maxBudgetUsd")
    expect(receipt.executionPlan).toHaveProperty("limits.maxBudgetUsd")
  })
  it("preserves new public receipts on replay", () => {
    const receipt = { id: "scan-1", ...publicScanProvenance(plan) }
    expect(publicScanResult(receipt)).toEqual(receipt)
  })
  it.each([null, {}, { ...plan, unexpectedPrivateField: "private" }])(
    "returns unavailable provenance for malformed or legacy plans",
    (raw) => {
      expect(publicScanProvenance(raw)).toEqual({ executionPlan: null, executionPlanHash: null })
    }
  )
})
