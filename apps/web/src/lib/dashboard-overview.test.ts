import { describe, it, expect } from "vitest"
import {
  applyTargetCoverageToVerdict,
  buildDashboardOverview,
  coverageStateFromReceipts,
  userSafeRunFailure,
  workspaceEvidenceIsComplete,
} from "./dashboard-overview"

const makeRun = (
  overrides: Partial<Parameters<typeof buildDashboardOverview>[0]["terminalRuns"][number]> = {}
) => ({
  id: overrides.id ?? "scan-1",
  targetId: overrides.targetId ?? "target-1",
  status: overrides.status ?? "COMPLETED",
  mode: overrides.mode ?? "STANDARD",
  createdAt: overrides.createdAt ?? new Date("2026-08-01T10:00:00Z"),
  endedAt: overrides.endedAt ?? new Date("2026-08-01T10:10:00Z"),
  summary: null,
  errorCategory: null,
  errorMessage: null,
  target: overrides.target ?? { id: "target-1", name: "Web app" },
  _count: { findings: overrides.findingCount ?? 0 },
})

describe("coverageStateFromReceipts", () => {
  it("is NONE when a run has no receipts", () => {
    expect(coverageStateFromReceipts([])).toBe("NONE")
  })

  it("is NONE when every receipt is not applicable", () => {
    expect(coverageStateFromReceipts(["NOT_APPLICABLE", "NOT_APPLICABLE"])).toBe("NONE")
  })

  it("is COMPLETE when every applicable receipt completed", () => {
    expect(coverageStateFromReceipts(["COMPLETED", "NOT_APPLICABLE", "COMPLETED"])).toBe("COMPLETE")
  })

  it("is PARTIAL when an applicable receipt did not complete", () => {
    expect(coverageStateFromReceipts(["COMPLETED", "BLOCKED"])).toBe("PARTIAL")
    expect(coverageStateFromReceipts(["PARTIAL"])).toBe("PARTIAL")
    expect(coverageStateFromReceipts(["TIMED_OUT"])).toBe("PARTIAL")
  })
})

describe("workspace verdict target-coverage gate", () => {
  const complete = {
    total: 2,
    assessed: 2,
    partiallyAssessed: 0,
    unassessed: 0,
    expiredAssessments: 0,
  }

  it("keeps a positive verdict when every target has usable evidence", () => {
    expect(workspaceEvidenceIsComplete(complete)).toBe(true)
    expect(applyTargetCoverageToVerdict("GO", complete)).toEqual({
      verdict: "GO",
      coverageCondition: null,
    })
  })

  it("refuses a positive verdict while a target is unassessed", () => {
    const targets = { ...complete, assessed: 1, unassessed: 1 }
    expect(workspaceEvidenceIsComplete(targets)).toBe(false)
    const downgraded = applyTargetCoverageToVerdict("GO", targets)
    expect(downgraded.verdict).toBe("NOT_EVALUATED")
    expect(downgraded.coverageCondition).toContain("1 of 2 targets")
  })

  it("refuses GO_WITH_CONDITIONS while a target is unassessed — conditions still read as approval", () => {
    const targets = { ...complete, assessed: 1, partiallyAssessed: 1, unassessed: 1, total: 3 }
    expect(applyTargetCoverageToVerdict("GO_WITH_CONDITIONS", targets).verdict).toBe(
      "NOT_EVALUATED"
    )
  })

  it("keeps a positive verdict when a target has partial but usable coverage", () => {
    const targets = { ...complete, assessed: 1, partiallyAssessed: 1 }
    expect(workspaceEvidenceIsComplete(targets)).toBe(true)
    expect(applyTargetCoverageToVerdict("GO_WITH_CONDITIONS", targets).verdict).toBe(
      "GO_WITH_CONDITIONS"
    )
  })

  it("refuses a positive verdict when the latest score expired", () => {
    const targets = { ...complete, expiredAssessments: 1 }
    const downgraded = applyTargetCoverageToVerdict("GO", targets)
    expect(downgraded.verdict).toBe("NOT_EVALUATED")
    expect(downgraded.coverageCondition).toContain("expired")
  })

  it("never grants a positive verdict to a workspace without targets", () => {
    const empty = {
      total: 0,
      assessed: 0,
      partiallyAssessed: 0,
      unassessed: 0,
      expiredAssessments: 0,
    }
    expect(workspaceEvidenceIsComplete(empty)).toBe(false)
  })

  it("leaves negative verdicts untouched", () => {
    const targets = { ...complete, assessed: 1, unassessed: 1 }
    expect(applyTargetCoverageToVerdict("NO_GO", targets).verdict).toBe("NO_GO")
    expect(applyTargetCoverageToVerdict("INCONCLUSIVE", targets).verdict).toBe("INCONCLUSIVE")
  })
})

describe("buildDashboardOverview", () => {
  it("binds the last evaluated assessment to its producing scan, not the newest snapshot", () => {
    // Newest snapshot describes a scan that evaluated nothing (NONE coverage);
    // an older snapshot has PARTIAL coverage and must be selected instead.
    const overview = buildDashboardOverview({
      targets: [{ id: "target-1", name: "Web app" }],
      terminalRuns: [
        makeRun({ id: "scan-old", createdAt: new Date("2026-08-01T10:00:00Z") }),
        makeRun({ id: "scan-new", createdAt: new Date("2026-08-02T10:00:00Z") }),
      ],
      receiptsByScanId: new Map([
        ["scan-old", ["COMPLETED"]],
        ["scan-new", ["NOT_APPLICABLE"]],
      ]),
      findingGroups: [],
      evaluatedCandidates: [
        {
          scanId: "scan-new",
          targetId: "target-1",
          targetName: "Web app",
          mode: "STANDARD",
          completedAt: new Date("2026-08-02T10:10:00Z"),
          score: 100,
          grade: "A_PLUS",
          expiresAt: new Date("2026-09-02T10:10:00Z"),
          receiptStatuses: ["NOT_APPLICABLE"],
        },
        {
          scanId: "scan-old",
          targetId: "target-1",
          targetName: "Web app",
          mode: "STANDARD",
          completedAt: new Date("2026-08-01T10:10:00Z"),
          score: 88,
          grade: "B",
          expiresAt: new Date("2026-09-01T10:10:00Z"),
          receiptStatuses: ["COMPLETED", "PARTIAL"],
        },
      ],
    })
    expect(overview.lastEvaluatedAssessment?.scanId).toBe("scan-old")
    expect(overview.lastEvaluatedAssessment?.score).toBe(88)
    expect(overview.lastEvaluatedAssessment?.coverageState).toBe("PARTIAL")
  })

  it("reports an inconclusive latest run alongside an earlier evaluated assessment", () => {
    const overview = buildDashboardOverview({
      targets: [{ id: "target-1", name: "Web app" }],
      terminalRuns: [
        makeRun({
          id: "scan-latest",
          status: "COMPLETED",
          createdAt: new Date("2026-08-03T10:00:00Z"),
        }),
      ],
      receiptsByScanId: new Map([["scan-latest", ["NOT_APPLICABLE"]]]),
      findingGroups: [
        { severity: "CRITICAL", status: "OPEN", verified: false, count: 1 },
        { severity: "HIGH", status: "OPEN", verified: false, count: 2 },
        { severity: "MEDIUM", status: "FIX_READY", verified: false, count: 2 },
        { severity: "LOW", status: "FIXED", verified: false, count: 1 },
        { severity: "LOW", status: "ACCEPTED_RISK", verified: false, count: 1 },
      ],
      evaluatedCandidates: [
        {
          scanId: "scan-earlier",
          targetId: "target-1",
          targetName: "Web app",
          mode: "STANDARD",
          completedAt: new Date("2026-08-01T10:10:00Z"),
          score: 90,
          grade: "A",
          expiresAt: new Date("2026-09-01T10:10:00Z"),
          receiptStatuses: ["COMPLETED"],
        },
      ],
    })
    expect(overview.latestRun?.id).toBe("scan-latest")
    expect(overview.latestRun?.coverageState).toBe("NONE")
    expect(overview.lastEvaluatedAssessment?.scanId).toBe("scan-earlier")
    expect(overview.targets).toMatchObject({ total: 1, unassessed: 1, assessed: 0 })
  })

  it("computes zero, partial, complete, and expired target coverage", () => {
    const overview = buildDashboardOverview({
      targets: [
        { id: "t-none", name: "No run" },
        { id: "t-partial", name: "Partial" },
        { id: "t-complete", name: "Complete" },
      ],
      terminalRuns: [
        makeRun({
          id: "s-partial",
          targetId: "t-partial",
          target: { id: "t-partial", name: "Partial" },
        }),
        makeRun({
          id: "s-complete",
          targetId: "t-complete",
          target: { id: "t-complete", name: "Complete" },
        }),
      ],
      receiptsByScanId: new Map([
        ["s-partial", ["COMPLETED", "FAILED"]],
        ["s-complete", ["COMPLETED", "COMPLETED"]],
      ]),
      findingGroups: [],
      evaluatedCandidates: [],
      now: new Date("2026-08-15T00:00:00Z"),
    })
    expect(overview.targets).toEqual({
      total: 3,
      assessed: 1,
      partiallyAssessed: 1,
      unassessed: 1,
      expiredAssessments: 0,
    })
  })

  it("counts expired assessments against the score expiry date", () => {
    const overview = buildDashboardOverview({
      targets: [{ id: "target-1", name: "Web app" }],
      terminalRuns: [makeRun({})],
      receiptsByScanId: new Map([["scan-1", ["COMPLETED"]]]),
      findingGroups: [],
      evaluatedCandidates: [
        {
          scanId: "scan-1",
          targetId: "target-1",
          targetName: "Web app",
          mode: "STANDARD",
          completedAt: new Date("2026-07-01T10:00:00Z"),
          score: 95,
          grade: "A",
          expiresAt: new Date("2026-08-01T10:00:00Z"),
          receiptStatuses: ["COMPLETED"],
        },
      ],
      now: new Date("2026-08-15T00:00:00Z"),
    })
    expect(overview.targets.expiredAssessments).toBe(1)
    expect(overview.lastEvaluatedAssessment?.scoreExpiresAt).toBe("2026-08-01T10:00:00.000Z")
  })

  it("keeps a user-safe failure message and never raw error text on the latest run", () => {
    const overview = buildDashboardOverview({
      targets: [{ id: "target-1", name: "Web app" }],
      terminalRuns: [
        makeRun({ id: "scan-failed", status: "STOPPED_BUDGET", errorCategory: "BUDGET_EXCEEDED" }),
      ],
      receiptsByScanId: new Map(),
      findingGroups: [],
      evaluatedCandidates: [],
    })
    expect(overview.latestRun?.userSafeFailure).toBe(
      "The run stopped because its protected limit was reached before completing."
    )
    expect(overview.latestRun?.userSafeFailure).not.toContain("BUDGET_EXCEEDED")
  })

  it("labels issue totals as workspace-wide data the caller can present", () => {
    const overview = buildDashboardOverview({
      targets: [{ id: "target-1", name: "Web app" }],
      terminalRuns: [],
      receiptsByScanId: new Map(),
      findingGroups: [
        { severity: "CRITICAL", status: "OPEN", verified: false, count: 4 },
        { severity: "HIGH", status: "OPEN", verified: false, count: 12 },
        { severity: "MEDIUM", status: "OPEN", verified: true, count: 71 },
        { severity: "LOW", status: "FIXED", verified: false, count: 5 },
        { severity: "LOW", status: "FIX_READY", verified: false, count: 3 },
        { severity: "LOW", status: "ACCEPTED_RISK", verified: false, count: 2 },
      ],
      evaluatedCandidates: [],
    })
    expect(overview.openIssues).toEqual({
      total: 92,
      critical: 4,
      high: 12,
      independentlyVerified: 71,
    })
    expect(overview.remediation).toEqual({ fixed: 5, inProgress: 3, riskAccepted: 2 })
  })
})

describe("userSafeRunFailure", () => {
  it("maps terminal statuses to user-safe copy", () => {
    expect(userSafeRunFailure("TIMED_OUT", null)).toContain("timed out")
    expect(userSafeRunFailure("FAILED", "QUEUE")).toContain("worker capacity")
    expect(userSafeRunFailure("FAILED", "ENGINE")).toContain("failed")
    expect(userSafeRunFailure("STOPPED_BUDGET", null)).toContain("protected limit")
  })
})
