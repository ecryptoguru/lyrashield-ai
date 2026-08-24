import { describe, expect, it } from "vitest"
import { calculateFindingPriority } from "./finding-priority"

const HEURISTIC_LIMITATION =
  "Priority is heuristic triage context, not proof of exploitability or reachability."

function input(overrides: Partial<Parameters<typeof calculateFindingPriority>[0]> = {}) {
  return {
    severity: "CRITICAL" as const,
    status: "OPEN" as const,
    verified: false,
    confidence: "medium",
    environment: null,
    businessImpact: null,
    exploitability: null,
    ...overrides,
  }
}

describe("calculateFindingPriority", () => {
  it("scores every severity on the approved weight ladder", () => {
    // confidence "low" contributes zero so the ladder isolates severity weight.
    const expected: Record<string, number> = {
      CRITICAL: 60,
      HIGH: 45,
      MEDIUM: 30,
      LOW: 15,
      INFO: 5,
    }
    for (const [severity, score] of Object.entries(expected)) {
      expect(
        calculateFindingPriority(input({ severity: severity as never, confidence: "low" })).score
      ).toBe(score)
    }
  })

  it("applies band boundaries exactly", () => {
    expect(calculateFindingPriority(input({ severity: "CRITICAL", verified: true, environment: "PRODUCTION", confidence: "high", businessImpact: "x", exploitability: "y" })).band).toBe("urgent")
    // 80 is exactly the urgent boundary: CRITICAL 60 + verified 15 + production 5... 60+15+10+5+4+4 = 98
    expect(calculateFindingPriority(input({ severity: "HIGH", verified: true, environment: "PRODUCTION", confidence: "high", businessImpact: "x", exploitability: "y" })).score).toBeGreaterThanOrEqual(80)
    // HIGH 45 + production 10 + high 5 + verified 15 + 4 + 4 = 83 -> urgent
    expect(calculateFindingPriority(input({ severity: "HIGH", verified: true, environment: "PRODUCTION", confidence: "high", businessImpact: "x", exploitability: "y" })).band).toBe("urgent")
    // MEDIUM 30 + production 10 + high 5 + verified 15 + 8 = 68 -> high
    expect(calculateFindingPriority(input({ severity: "MEDIUM", verified: true, environment: "PRODUCTION", confidence: "high", businessImpact: "x", exploitability: "y" })).band).toBe("high")
    // LOW 15 + production 10 + verified 15 + high 5 + 8 = 53 -> normal
    expect(calculateFindingPriority(input({ severity: "LOW", verified: true, environment: "PRODUCTION", confidence: "high", businessImpact: "x", exploitability: "y" })).band).toBe("normal")
    // INFO 5 + production 10 + high 5 + 8 = 28 -> low
    expect(calculateFindingPriority(input({ severity: "INFO", environment: "PRODUCTION", confidence: "high", businessImpact: "x", exploitability: "y" })).band).toBe("low")
  })

  it("clamps the score to 0..100", () => {
    const maxed = calculateFindingPriority(
      input({ severity: "CRITICAL", verified: true, environment: "PRODUCTION", confidence: "high", businessImpact: "x", exploitability: "y" })
    )
    expect(maxed.score).toBeLessThanOrEqual(100)
    expect(maxed.score).toBeGreaterThanOrEqual(0)
  })

  it("ranks a verified critical production finding above an unverified critical staging finding", () => {
    const verifiedProduction = calculateFindingPriority(
      input({ severity: "CRITICAL", status: "OPEN", verified: true, environment: "PRODUCTION", confidence: "high" })
    )
    const unverifiedStaging = calculateFindingPriority(
      input({ severity: "CRITICAL", status: "OPEN", verified: false, environment: "STAGING", confidence: "medium" })
    )
    expect(verifiedProduction.score).toBeGreaterThan(unverifiedStaging.score)
    expect(verifiedProduction.band).toBe("urgent")
    expect(unverifiedStaging.band).toBe("high")
  })

  it("keeps text-presence changes within a bounded 8-point range", () => {
    const withoutText = calculateFindingPriority(
      input({ severity: "HIGH", status: "OPEN", verified: false, environment: "STAGING", confidence: "medium" })
    )
    const withText = calculateFindingPriority(
      input({ severity: "HIGH", status: "OPEN", verified: false, environment: "STAGING", confidence: "medium", businessImpact: "Customer payments", exploitability: "Publicly reachable" })
    )
    expect(withText.score - withoutText.score).toBeLessThanOrEqual(8)
    expect(withText.reasons).toContain("Business impact context available")
    expect(withText.reasons).toContain("Exploitability context available")
    // Text presence must not flip the dominant severity conclusion.
    expect(withText.band).toBe(withoutText.band)
  })

  it("treats whitespace-only context text as absent", () => {
    const whitespace = calculateFindingPriority(
      input({ severity: "MEDIUM", businessImpact: "   ", exploitability: "\n\t" })
    )
    const absent = calculateFindingPriority(input({ severity: "MEDIUM" }))
    expect(whitespace.score).toBe(absent.score)
    expect(whitespace.reasons).not.toContain("Business impact context available")
    expect(whitespace.reasons).not.toContain("Exploitability context available")
  })

  it("normalizes confidence case-insensitively and flags unknown values", () => {
    const highUpper = calculateFindingPriority(input({ severity: "MEDIUM", confidence: "High" }))
    const highLower = calculateFindingPriority(input({ severity: "MEDIUM", confidence: "high" }))
    expect(highUpper.score).toBe(highLower.score)

    const unknown = calculateFindingPriority(input({ severity: "MEDIUM", confidence: "unranked" }))
    expect(unknown.limitations).toContain("Confidence signal is unknown; triage metadata is not proof.")
  })

  it("adds a limitation when the target environment is missing", () => {
    const result = calculateFindingPriority(input({ severity: "MEDIUM" }))
    expect(result.limitations).toContain("Target environment is unknown; production exposure was not considered.")
  })

  it("adds a limitation for unverified findings", () => {
    const result = calculateFindingPriority(input({ severity: "MEDIUM", verified: false }))
    expect(result.limitations).toContain(
      "No trusted verification evidence; this is a detected finding, not independently verified."
    )
  })

  it("always declares the heuristic boundary", () => {
    for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const) {
      expect(calculateFindingPriority(input({ severity })).limitations).toContain(
        HEURISTIC_LIMITATION
      )
    }
  })

  it.each([
    ["ACCEPTED_RISK", "Risk accepted"],
    ["FALSE_POSITIVE", "False positive"],
    ["DUPLICATE", "Duplicate"],
    ["FIXED", "Fixed after retest"],
  ] as const)("caps the resolved status %s at low priority", (status, reason) => {
    const result = calculateFindingPriority(input({ severity: "CRITICAL", status, verified: true, environment: "PRODUCTION", confidence: "high", businessImpact: "x", exploitability: "y" }))
    expect(result.score).toBeLessThanOrEqual(20)
    expect(result.band).toBe("low")
    expect(result.reasons[0]).toBe(reason)
  })

  it("keeps FIXED_PENDING_RETEST active until a trusted retest receipt exists", () => {
    const pending = calculateFindingPriority(
      input({ severity: "CRITICAL", status: "FIXED_PENDING_RETEST", environment: "PRODUCTION" })
    )
    expect(pending.score).toBeGreaterThan(20)
    expect(pending.band).not.toBe("low")
  })

  it("never claims reachability or exploitability was proven", () => {
    const result = calculateFindingPriority(
      input({ severity: "CRITICAL", businessImpact: "Customer payments", exploitability: "Publicly reachable" })
    )
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("reachable")
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("exploitable")
    expect(result.limitations.join(" ").toLowerCase()).not.toContain("verified risk")
    expect(result.limitations.join(" ")).toContain("not independently verified")
  })
})
