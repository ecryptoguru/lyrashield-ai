import { describe, expect, it } from "vitest"
import { deriveHomeNextAction } from "./home-next-action"

const base = {
  targets: { total: 1, assessed: 0, partiallyAssessed: 0, unassessed: 1, expiredAssessments: 0 },
  lastEvaluatedAssessment: null,
  remediation: { fixed: 0, inProgress: 0, riskAccepted: 0 },
  reportCount: 0,
}

describe("deriveHomeNextAction", () => {
  it("sends a workspace without targets to add its first target", () => {
    const action = deriveHomeNextAction(
      { ...base, targets: { ...base.targets, total: 0, unassessed: 0 } },
      { total: 0, critical: 0, high: 0 }
    )
    expect(action?.title).toBe("Add your first target")
    expect(action?.href).toBe("/dashboard/targets")
  })

  it("asks for a first review when a target exists but nothing has been evaluated", () => {
    const action = deriveHomeNextAction(base, { total: 0, critical: 0, high: 0 })
    expect(action?.title).toBe("Run your first review")
    expect(action?.href).toBe("/dashboard/scans?new=1")
  })

  it("points at the highest-priority issue once evidence exists with blockers", () => {
    const action = deriveHomeNextAction(
      {
        ...base,
        lastEvaluatedAssessment: {
          scanId: "scan-1",
          targetId: "t1",
          targetName: "Web app",
          mode: "STANDARD",
          completedAt: "2026-08-01T00:00:00.000Z",
          coverageState: "COMPLETE",
          score: 62,
          grade: "C",
          scoreExpiresAt: "2026-09-01T00:00:00.000Z",
        },
      },
      { total: 5, critical: 1, high: 2 }
    )
    expect(action?.title).toBe("Review the highest-priority issue")
    expect(action?.href).toBe("/dashboard/findings")
    expect(action?.description).toContain("3 unresolved critical or high issue")
    expect(action?.description).toContain("Detection is not verification")
  })

  it("asks for an assurance report when there are no blockers but no report", () => {
    const action = deriveHomeNextAction(
      {
        ...base,
        lastEvaluatedAssessment: {
          scanId: "scan-1",
          targetId: "t1",
          targetName: "Web app",
          mode: "STANDARD",
          completedAt: "2026-08-01T00:00:00.000Z",
          coverageState: "COMPLETE",
          score: 95,
          grade: "A",
          scoreExpiresAt: "2026-09-01T00:00:00.000Z",
        },
      },
      { total: 2, critical: 0, high: 0 }
    )
    expect(action?.title).toBe("Generate an assurance report")
    expect(action?.href).toBe("/dashboard/findings?tab=reports")
  })

  it("renders no onboarding instruction once the initial journey is complete", () => {
    const action = deriveHomeNextAction(
      {
        ...base,
        lastEvaluatedAssessment: {
          scanId: "scan-1",
          targetId: "t1",
          targetName: "Web app",
          mode: "STANDARD",
          completedAt: "2026-08-01T00:00:00.000Z",
          coverageState: "COMPLETE",
          score: 95,
          grade: "A",
          scoreExpiresAt: "2026-09-01T00:00:00.000Z",
        },
        reportCount: 2,
      },
      { total: 0, critical: 0, high: 0 }
    )
    expect(action).toBeNull()
  })
})
