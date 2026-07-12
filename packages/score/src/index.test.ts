import { describe, expect, it } from "vitest"
import { computeScore } from "./index"

const standard = { mode: "STANDARD" as const, isDefaultBranch: true }

describe("computeScore", () => {
  it("is deterministic and applies score, grade, and secret caps", () => {
    const input = [{ severity: "CRITICAL" as const, status: "OPEN" as const, verified: true }]
    expect(computeScore(input, standard)).toEqual(computeScore(input, standard))
    expect(computeScore(input, standard)).toMatchObject({
      score: 75,
      grade: "C",
      shareEligible: true,
    })
    expect(
      computeScore(
        [{ severity: "LOW", status: "OPEN", verified: true, activeSecret: true }],
        standard
      ).grade
    ).toBe("D")
  })

  it("keeps accepted risk at half weight and SAFE scans provisional", () => {
    const result = computeScore([{ severity: "HIGH", status: "ACCEPTED_RISK", verified: true }], {
      mode: "SAFE",
      isDefaultBranch: true,
    })
    expect(result.score).toBe(95)
    expect(result.shareEligible).toBe(false)
  })
})
