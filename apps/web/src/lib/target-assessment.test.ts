import { describe, expect, it } from "vitest"
import { projectTargetAssessment, type TargetAssessmentSource } from "./target-assessment"

const source: TargetAssessmentSource = {
  target: { id: "target-1", name: "App", type: "REPO", environment: "PRODUCTION" },
  canStartScan: true,
  latestScan: null,
  gate: { status: "available", value: null },
  remediation: {
    status: "available",
    value: {
      newFindings: 0,
      recurringFindings: 0,
      resolvedFindings: 0,
      uncertainMatches: 0,
      blockingFindings: 0,
    },
  },
  spend: { status: "available", value: null },
}

const readyGate = {
  verdictId: "verdict-1",
  state: "READY" as const,
  historicalState: "READY" as const,
  applicable: true,
  reasons: [],
  assessedIdentity: { kind: "COMMIT" as const, value: "a".repeat(40) },
  evaluatedAt: "2026-11-05T00:00:00.000Z",
  coverageStatement: ["sast", "secrets"],
  nonCoverage: [],
}

describe("projectTargetAssessment", () => {
  it("starts a review when no assessment exists", () => {
    const projection = projectTargetAssessment(source)
    expect(projection.nextAction.code).toBe("START_REVIEW")
    expect(projection.nextAction.href).toContain("new=1")
    expect(projection.nextAction.href).toContain("target=target-1")
  })

  it("links to the active run before proposing another review", () => {
    const projection = projectTargetAssessment({
      ...source,
      latestScan: {
        id: "scan-1",
        status: "RUNNING",
        goal: "TEST_APP",
        mode: "STANDARD",
        createdAt: "2026-11-05T00:00:00.000Z",
        startedAt: "2026-11-05T00:01:00.000Z",
        endedAt: null,
        sourceRevision: "b".repeat(40),
      },
    })
    expect(projection.execution.deliveryState).toBe("RUNNING")
    expect(projection.nextAction).toMatchObject({
      code: "VIEW_RUNNING_REVIEW",
      href: "/dashboard/scans/scan-1",
    })
  })

  it("fails toward refresh when the stored gate panel is unavailable", () => {
    const projection = projectTargetAssessment({
      ...source,
      gate: { status: "unavailable", code: "READ_FAILED" },
    })
    expect(projection.nextAction.code).toBe("REFRESH_ASSESSMENT")
    expect(projection.coverage.status).toBe("unavailable")
  })

  it("routes blockers before release packet creation", () => {
    const projection = projectTargetAssessment({
      ...source,
      gate: {
        status: "available",
        value: { ...readyGate, state: "NOT_READY", historicalState: "NOT_READY" },
      },
    })
    expect(projection.nextAction.code).toBe("REVIEW_BLOCKERS")
    expect(projection.nextAction.href).toBe("/dashboard/findings?target=target-1")
  })

  it("requires current coverage for an insufficient or inapplicable verdict", () => {
    const projection = projectTargetAssessment({
      ...source,
      gate: {
        status: "available",
        value: {
          ...readyGate,
          state: "INSUFFICIENT_EVIDENCE",
          applicable: false,
          nonCoverage: [{ controlId: "sca", scanner: "sca", reason: "scanner unavailable" }],
        },
      },
    })
    expect(projection.nextAction.code).toBe("COMPLETE_COVERAGE")
    expect(projection.coverage).toMatchObject({ status: "available", value: { complete: false } })
  })

  it("routes a current ready release to the release packet", () => {
    const projection = projectTargetAssessment({
      ...source,
      gate: { status: "available", value: readyGate },
    })
    expect(projection.nextAction.code).toBe("CREATE_RELEASE_PACKET")
    expect(projection.nextAction.href).toContain("targetId=target-1")
    expect(projection.nextAction.href).toContain(`commit=${"a".repeat(40)}`)
    expect(projection.assessment?.assessedIdentity?.value).toBe("a".repeat(40))
  })

  it("does not offer a scan when the actor lacks scan creation permission", () => {
    const projection = projectTargetAssessment({ ...source, canStartScan: false })
    expect(projection.nextAction.code).toBe("RECOVER_ACCESS")
  })
})
