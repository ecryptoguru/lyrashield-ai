import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { TargetAssessmentProjection } from "@/lib/target-assessment"
import { TargetAssessmentSummary } from "./target-assessment-summary"
import { TargetSpendSummary } from "./target-spend-summary"

const base: TargetAssessmentProjection = {
  target: { id: "target-1", name: "App", type: "REPO", environment: "PRODUCTION" },
  assessment: null,
  assessmentState: "available",
  assessmentUnavailableCode: null,
  execution: {
    latestScanId: null,
    status: null,
    sourceRevision: null,
    startedAt: null,
    endedAt: null,
    deliveryState: "UNKNOWN",
  },
  coverage: {
    status: "available",
    value: { complete: false, coverageStatement: [], nonCoverage: [] },
  },
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
  nextAction: {
    code: "START_REVIEW",
    label: "Start launch review",
    href: "/dashboard/scans?new=1&target=target-1",
  },
}

describe("target assessment summary", () => {
  it("shows an honest not-assessed state and one primary next action", () => {
    const html = renderToStaticMarkup(<TargetAssessmentSummary projection={base} />)
    expect(html).toContain("Not assessed")
    expect(html).toContain("Start launch review")
    expect(html).not.toContain("ready for")
  })

  it("renders stored identity, coverage omissions and remediation counts", () => {
    const html = renderToStaticMarkup(
      <TargetAssessmentSummary
        projection={{
          ...base,
          assessment: {
            verdictId: "verdict-1",
            state: "INSUFFICIENT_EVIDENCE",
            historicalState: "READY",
            applicable: false,
            reasons: [{ code: "EVIDENCE_CHANGED", message: "Evidence changed" }],
            assessedIdentity: { kind: "COMMIT", value: "a".repeat(40) },
            evaluatedAt: "2026-11-05T00:00:00.000Z",
            coverageStatement: ["sast"],
            nonCoverage: [
              { controlId: "sca", scanner: "sca", reason: "dependency feed unavailable" },
            ],
          },
          coverage: {
            status: "available",
            value: {
              complete: false,
              coverageStatement: ["sast"],
              nonCoverage: [
                { controlId: "sca", scanner: "sca", reason: "dependency feed unavailable" },
              ],
            },
          },
          remediation: {
            status: "available",
            value: {
              newFindings: 2,
              recurringFindings: 3,
              resolvedFindings: 1,
              uncertainMatches: 1,
              blockingFindings: 2,
            },
          },
        }}
      />
    )
    expect(html).toContain("Not enough evidence")
    expect(html).toContain("aaaaaaaa")
    expect(html).toContain("dependency feed unavailable")
    expect(html).toContain(">New</dt>")
    expect(html).toContain(">Recurring</dt>")
    expect(html).toContain(">Resolved</dt>")
    expect(html).toContain(">Uncertain</dt>")
    expect(html).toContain('tabular-nums">2</dd>')
  })

  it("separates an unavailable assessment from a valid empty result", () => {
    const html = renderToStaticMarkup(
      <TargetAssessmentSummary
        projection={{
          ...base,
          assessmentState: "unavailable",
          assessmentUnavailableCode: "GATE_UNAVAILABLE",
          coverage: { status: "unavailable", code: "GATE_UNAVAILABLE" },
          nextAction: {
            code: "REFRESH_ASSESSMENT",
            label: "Refresh assessment",
            href: "/dashboard/targets/target-1",
          },
        }}
      />
    )
    expect(html).toContain("Assessment unavailable")
    expect(html).toContain("GATE_UNAVAILABLE")
    expect(html).not.toContain("No completed assessment")
  })
})

describe("target spend summary", () => {
  it("shows consumed, reserved and maximum separately without rendering unknown as zero", () => {
    const html = renderToStaticMarkup(
      <TargetSpendSummary
        projection={{
          status: "available",
          value: {
            maximum: {
              state: "known",
              amountUsd: "3.20",
              source: "ADMITTED_PROVIDER_CEILING",
              observedAt: "2026-11-05T00:00:00.000Z",
            },
            consumed: { state: "unavailable", reason: "SETTLEMENT_PENDING" },
            reserved: { state: "unavailable", reason: "NO_PROVIDER_DOLLAR_RESERVATION" },
            agentMinutes: { funded: 5, charged: 2, absorbed: 1 },
          },
        }}
      />
    )
    expect(html).toContain("Spend")
    expect(html).toContain("$3.20")
    expect(html).toContain("Unknown — settlement still pending")
    expect(html).toContain("Not persisted")
    expect(html).toContain("Funded 5")
    expect(html).not.toContain("Consumed $0.00")
  })

  it("keeps unauthorized spend details private", () => {
    const html = renderToStaticMarkup(
      <TargetSpendSummary projection={{ status: "available", value: null }} />
    )
    expect(html).toContain("available to the scan sponsor or billing manager")
    expect(html).not.toContain("$")
  })
})
