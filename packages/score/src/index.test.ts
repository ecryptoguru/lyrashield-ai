import { describe, expect, it } from "vitest"
import { computeScore, SCORE_MODEL_VERSION, type FindingInput } from "./index"

const standard = { mode: "STANDARD" as const, isDefaultBranch: true }

function finding(overrides: Partial<FindingInput>): FindingInput {
  return { severity: "LOW", status: "OPEN", verified: true, ...overrides }
}

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

  it("carries the versioned model id", () => {
    expect(SCORE_MODEL_VERSION).toBe("lyrashield-score/1.0.0")
  })

  // Spec §1 deduction table: verified full weight, unverified ×0.25, round half-up.
  it.each([
    ["CRITICAL", true, 75],
    ["CRITICAL", false, 94], // 100 − 6.25 = 93.75 → 94
    ["HIGH", true, 90],
    ["HIGH", false, 98], // 100 − 2.5 = 97.5 → 98
    ["MEDIUM", true, 96],
    ["MEDIUM", false, 99],
    ["LOW", true, 99],
    ["LOW", false, 100], // 100 − 0.25 = 99.75 → 100
    ["INFO", true, 100],
  ] as const)("deducts %s (verified=%s) to %i", (severity, verified, expected) => {
    expect(computeScore([finding({ severity, verified })], standard).score).toBe(expected)
  })

  // Spec §1 grade bands at exact boundaries (unverified LOWs: 4 findings = exactly 1 point).
  it("bands scores at exact boundaries", () => {
    const lows = (points: number) =>
      Array.from({ length: points * 4 }, () => finding({ severity: "LOW", verified: false }))
    expect(computeScore([], standard).grade).toBe("A_PLUS") // 100
    expect(computeScore(lows(2), standard).grade).toBe("A_PLUS") // 98
    expect(computeScore(lows(3), standard).grade).toBe("A") // 97
    expect(computeScore(lows(10), standard).grade).toBe("A") // 90
    expect(computeScore(lows(11), standard).grade).toBe("B") // 89
    expect(computeScore(lows(20), standard).grade).toBe("B") // 80
    expect(computeScore(lows(21), standard).grade).toBe("C") // 79
    expect(computeScore(lows(35), standard).grade).toBe("C") // 65
    expect(computeScore(lows(36), standard).grade).toBe("D") // 64
    expect(computeScore(lows(50), standard).grade).toBe("D") // 50
    expect(computeScore(lows(51), standard).grade).toBe("F") // 49
  })

  it("floors the score at zero", () => {
    const criticals = Array.from({ length: 6 }, () => finding({ severity: "CRITICAL" }))
    expect(computeScore(criticals, standard).score).toBe(0)
  })

  it("denies A+ when any open finding is MEDIUM or higher", () => {
    // 1 unverified MEDIUM = −1 → score 99 (A+ band) but the open medium blocks A+.
    const result = computeScore([finding({ severity: "MEDIUM", verified: false })], standard)
    expect(result.score).toBe(99)
    expect(result.grade).toBe("A")
  })

  it("caps open verified HIGH at B even with an A-band score", () => {
    const result = computeScore([finding({ severity: "HIGH" })], standard)
    expect(result.score).toBe(90)
    expect(result.grade).toBe("B")
  })

  it("stacks caps safely — the lowest cap wins", () => {
    const result = computeScore(
      [finding({ severity: "CRITICAL" }), finding({ severity: "HIGH" })],
      standard
    )
    expect(result.grade).toBe("C")
  })

  it("ignores resolved and excluded statuses entirely", () => {
    const result = computeScore(
      [
        finding({ severity: "CRITICAL", status: "FIXED" }),
        finding({ severity: "CRITICAL", status: "FALSE_POSITIVE" }),
        finding({ severity: "CRITICAL", status: "DUPLICATE" }),
      ],
      standard
    )
    expect(result.score).toBe(100)
    expect(result.grade).toBe("A_PLUS")
    expect(result.breakdown.eligibleFindings).toBe(0)
  })

  it("treats FIXED_PENDING_RETEST as still open", () => {
    const result = computeScore(
      [finding({ severity: "HIGH", status: "FIXED_PENDING_RETEST" })],
      standard
    )
    expect(result.score).toBe(90)
    expect(result.grade).toBe("B")
  })

  it("does not apply open-only caps to accepted-risk findings", () => {
    const result = computeScore(
      [finding({ severity: "CRITICAL", status: "ACCEPTED_RISK", activeSecret: true })],
      standard
    )
    expect(result.score).toBe(88) // −12.5 → round half-up
    expect(result.grade).toBe("B") // no cap: the finding is not open
  })

  it("marks only STANDARD and DEEP canonical-branch scans share-eligible", () => {
    const modes = [
      ["SAFE", false],
      ["QUICK", false],
      ["STANDARD", true],
      ["DEEP", true],
      ["CUSTOM", false],
    ] as const
    for (const [mode, eligible] of modes) {
      expect(computeScore([], { mode, isDefaultBranch: true }).shareEligible).toBe(eligible)
    }
    expect(computeScore([], { mode: "STANDARD", isDefaultBranch: false }).shareEligible).toBe(false)
  })
})
