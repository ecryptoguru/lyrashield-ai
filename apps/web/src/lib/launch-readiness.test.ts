import { describe, it, expect } from "vitest"
import {
  generateLaunchReadinessReport,
  generateLaunchReadinessReportFromAggregate,
} from "./launch-readiness"

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

  it("aggregates more than 100 findings without pagination loss", () => {
    const report = generateLaunchReadinessReportFromAggregate(
      [{ severity: "HIGH" as never, status: "OPEN" as never, verified: true, count: 125 }],
      true
    )
    expect(report.totalFindings).toBe(125)
    expect(report.blockingFindings).toBe(125)
    expect(report.verdict).toBe("NO_GO")
  })

  /**
   * Observed live in production on 2026-08-02: a URL scan whose fetch was
   * blocked completed in 1s with zero findings, and the dashboard reported
   * 100/100, Grade A+, "Ready to launch". Zero findings from zero coverage is
   * the absence of evidence, not evidence of absence.
   */
  describe("coverage gating", () => {
    it("returns INCONCLUSIVE with no score when a completed scan evaluated nothing", () => {
      const report = generateLaunchReadinessReportFromAggregate([], true, {
        evaluated: false,
        reason: "URL content could not be fetched: the connection failed",
      })

      expect(report.verdict).toBe("INCONCLUSIVE")
      // The critical assertion: no number for a user to read as a pass.
      expect(report.score).toBeNull()
      expect(report.summary).toContain("not a clean result")
      expect(report.recommendations).toContain(
        "URL content could not be fetched: the connection failed"
      )
    })

    it("never returns GO when coverage failed, even with zero findings", () => {
      const report = generateLaunchReadinessReportFromAggregate([], true, { evaluated: false })
      expect(report.verdict).not.toBe("GO")
    })

    it("scores normally when coverage succeeded and nothing was found", () => {
      const report = generateLaunchReadinessReportFromAggregate([], true, { evaluated: true })
      expect(report.verdict).toBe("GO")
      expect(report.score).toBe(100)
    })

    it("is unchanged when no coverage information is supplied", () => {
      // Callers that cannot yet report coverage keep the previous behaviour
      // rather than being silently downgraded to INCONCLUSIVE.
      const report = generateLaunchReadinessReportFromAggregate([], true)
      expect(report.verdict).toBe("GO")
      expect(report.score).toBe(100)
    })

    it("still reports NOT_EVALUATED when no scan has completed at all", () => {
      const report = generateLaunchReadinessReportFromAggregate([], false, { evaluated: false })
      expect(report.verdict).toBe("NOT_EVALUATED")
    })
  })
})
