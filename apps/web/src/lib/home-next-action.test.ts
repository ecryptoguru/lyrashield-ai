import { describe, expect, it } from "vitest"
import { deriveHomeDecision, deriveHomeNextAction } from "./home-next-action"
import type { GateReadinessTarget } from "./launch-readiness"

const base = {
  targets: { total: 1, assessed: 0, partiallyAssessed: 0, unassessed: 1, expiredAssessments: 0 },
  lastEvaluatedAssessment: null,
  reportCount: 0,
  openIssues: { total: 0, critical: 0, high: 0 },
  gateTargets: [] as Pick<GateReadinessTarget, "state" | "applicable">[],
  activeScan: null,
}

function gate(state: "READY" | "NOT_READY" | "INSUFFICIENT_EVIDENCE", applicable = true) {
  return { state, applicable }
}

describe("deriveHomeDecision — one canonical action", () => {
  it("leads with scan progress while a scan is active instead of recommending a duplicate", () => {
    const decision = deriveHomeDecision({
      ...base,
      activeScan: { id: "scan-active", targetName: "Web app" },
    })
    expect(decision.action?.title).toBe("Scan in progress")
    expect(decision.action?.href).toBe("/dashboard/scans/scan-active")
    expect(decision.primaryAction.label).toBe("View scan progress")
    expect(decision.primaryAction.href).toBe("/dashboard/scans/scan-active")
  })

  it("sends a workspace without targets to add its first target", () => {
    const decision = deriveHomeDecision({
      ...base,
      targets: { ...base.targets, total: 0, unassessed: 0 },
    })
    expect(decision.action?.title).toBe("Add your first target")
    expect(decision.primaryAction).toEqual({ href: "/dashboard/targets", label: "Add a target" })
  })

  it("asks for a first scan when a target exists but nothing has been evaluated", () => {
    const decision = deriveHomeDecision(base)
    expect(decision.action?.title).toBe("Run your first review")
    expect(decision.action?.cta).toBe("Start a scan")
    expect(decision.primaryAction).toEqual({ href: "/dashboard/scans?new=1", label: "Start a scan" })
  })

  it("points at the highest-priority finding once evidence exists with blockers", () => {
    const decision = deriveHomeDecision({
      ...base,
      lastEvaluatedAssessment: evaluatedAssessment(),
      openIssues: { total: 5, critical: 1, high: 2 },
      gateTargets: [gate("READY")],
    })
    expect(decision.action?.cta).toBe("Open findings")
    expect(decision.action?.description).toContain("3 unresolved critical or high finding")
    expect(decision.action?.description).toContain("Detection is not verification")
    expect(decision.primaryAction.href).toBe("/dashboard/findings")
  })

  // W1-03: a clean score with insufficient gate evidence can never produce a
  // ready-oriented recommendation.
  it("refuses the report recommendation while a target lacks usable evidence", () => {
    const decision = deriveHomeDecision({
      ...base,
      lastEvaluatedAssessment: evaluatedAssessment(),
      gateTargets: [gate("READY"), gate("INSUFFICIENT_EVIDENCE")],
    })
    expect(decision.action?.cta).toBe("Start a scan")
    expect(decision.action?.title).not.toMatch(/report/i)
    expect(decision.action?.description).toContain("no launch decision is possible")
  })

  it("routes NOT_READY gate state to blocker remediation even with a clean score", () => {
    const decision = deriveHomeDecision({
      ...base,
      lastEvaluatedAssessment: evaluatedAssessment(),
      gateTargets: [gate("READY"), gate("NOT_READY")],
      reportCount: 0,
    })
    expect(decision.action?.cta).toBe("Review blockers")
    expect(decision.primaryAction.href).toBe("/dashboard/findings")
  })

  it("treats an expired assessment as insufficient for a ready-oriented action", () => {
    const decision = deriveHomeDecision({
      ...base,
      targets: { ...base.targets, expiredAssessments: 1 },
      lastEvaluatedAssessment: { ...evaluatedAssessment(), scoreExpiresAt: "2026-01-01T00:00:00.000Z" },
      gateTargets: [gate("INSUFFICIENT_EVIDENCE")],
    })
    expect(decision.action?.cta).toBe("Start a scan")
  })

  it("offers the report only when every active target's gate is READY", () => {
    const decision = deriveHomeDecision({
      ...base,
      lastEvaluatedAssessment: evaluatedAssessment(),
      gateTargets: [gate("READY"), gate("READY")],
    })
    expect(decision.action?.title).toBe("Generate an assurance report")
    expect(decision.action?.href).toBe("/dashboard/reports")
  })

  it("renders no onboarding instruction once the journey is complete", () => {
    const decision = deriveHomeDecision({
      ...base,
      lastEvaluatedAssessment: evaluatedAssessment(),
      reportCount: 2,
      gateTargets: [gate("READY")],
    })
    expect(decision.action).toBeNull()
  })

  it("keeps one coherent decision between the panel and the header CTA", () => {
    const decision = deriveHomeDecision(base)
    expect(decision.primaryAction.label).toBe("Start a scan")
    expect(decision.primaryAction.href).toBe(decision.action?.href)
  })

  it("keeps the legacy wrapper returning just the action", () => {
    expect(deriveHomeNextAction(base)?.cta).toBe("Start a scan")
  })
})

function evaluatedAssessment() {
  return {
    scanId: "scan-1",
    targetId: "t1",
    targetName: "Web app",
    mode: "STANDARD",
    completedAt: "2026-08-01T00:00:00.000Z",
    coverageState: "COMPLETE" as const,
    score: 95,
    grade: "A",
    scoreExpiresAt: "2026-09-01T00:00:00.000Z",
  }
}
