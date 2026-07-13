import { describe, it, expect } from "vitest"
import { generateLaunchReadinessReport } from "./launch-readiness"

const makeFinding = (
  overrides: Partial<{
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
    status: string
    verified: boolean
  }> = {}
) => ({
  id: `finding-${Math.random()}`,
  severity: (overrides.severity ?? "MEDIUM") as never,
  status: (overrides.status ?? "OPEN") as never,
  verified: overrides.verified ?? true,
  confidence: "medium",
  title: "Test finding",
  summary: "Test summary",
})

describe("generateLaunchReadinessReport", () => {
  it("does not evaluate readiness without a completed scan", () => {
    const report = generateLaunchReadinessReport([], false)
    expect(report.verdict).toBe("NOT_EVALUATED")
    expect(report.score).toBeNull()
  })

  it("returns GO when a completed scan has no findings", () => {
    const report = generateLaunchReadinessReport([], true)
    expect(report.verdict).toBe("GO")
    expect(report.score).toBe(100)
    expect(report.totalFindings).toBe(0)
  })

  it("returns NO_GO with critical open findings", () => {
    const report = generateLaunchReadinessReport(
      [makeFinding({ severity: "CRITICAL", status: "OPEN" })],
      true
    )
    expect(report.verdict).toBe("NO_GO")
    expect(report.blockingFindings).toBe(1)
    expect(report.score).toBeLessThan(100)
  })

  it("returns NO_GO with high open findings", () => {
    const report = generateLaunchReadinessReport(
      [makeFinding({ severity: "HIGH", status: "OPEN" })],
      true
    )
    expect(report.verdict).toBe("NO_GO")
    expect(report.blockingFindings).toBe(1)
  })

  it("returns GO when critical findings are fixed", () => {
    const report = generateLaunchReadinessReport(
      [makeFinding({ severity: "CRITICAL", status: "FIXED" })],
      true
    )
    expect(report.verdict).toBe("GO")
    expect(report.blockingFindings).toBe(0)
    expect(report.score).toBe(100)
  })

  it("returns GO_WITH_CONDITIONS for medium open findings", () => {
    const report = generateLaunchReadinessReport(
      [
        makeFinding({ severity: "MEDIUM", status: "OPEN" }),
        makeFinding({ severity: "MEDIUM", status: "OPEN" }),
        makeFinding({ severity: "MEDIUM", status: "OPEN" }),
      ],
      true
    )
    expect(report.verdict).toBe("GO_WITH_CONDITIONS")
    expect(report.conditions.length).toBeGreaterThan(0)
  })

  it("counts verified and unverified findings", () => {
    const report = generateLaunchReadinessReport(
      [makeFinding({ verified: true }), makeFinding({ verified: false })],
      true
    )
    expect(report.verifiedFindings).toBe(1)
    expect(report.totalFindings).toBe(2)
  })

  it("groups by severity", () => {
    const report = generateLaunchReadinessReport(
      [
        makeFinding({ severity: "CRITICAL", status: "FIXED" }),
        makeFinding({ severity: "HIGH", status: "FIXED" }),
        makeFinding({ severity: "HIGH", status: "FIXED" }),
      ],
      true
    )
    expect(report.bySeverity.CRITICAL).toBe(1)
    expect(report.bySeverity.HIGH).toBe(2)
  })

  it("recommends verification when no findings are verified", () => {
    const report = generateLaunchReadinessReport(
      [makeFinding({ verified: false, severity: "LOW", status: "OPEN" })],
      true
    )
    expect(report.recommendations).toContain(
      "No findings have been verified — run a deeper scan to confirm vulnerabilities"
    )
  })
})
