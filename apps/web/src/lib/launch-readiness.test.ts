import { describe, it, expect } from "vitest"
import {
  describeReleaseCheck,
  generateLaunchReadinessReport,
  generateLaunchReadinessReportFromAggregate,
  gateReasonSentence,
  parseReleaseReference,
  projectGateReadinessReport,
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

describe("projectGateReadinessReport", () => {
  it("maps Gate v2 NOT_READY without allowing a high score to override it", () => {
    const report = projectGateReadinessReport(
      [],
      [
        {
          targetId: "target-1",
          targetName: "API",
          state: "NOT_READY",
          applicable: true,
          blockingFindings: 1,
          reasons: [],
        },
      ]
    )
    expect(report.verdict).toBe("NO_GO")
    expect(report.blockingFindings).toBe(1)
  })

  it("maps missing expected identity to inconclusive", () => {
    const report = projectGateReadinessReport(
      [],
      [
        {
          targetId: "target-1",
          targetName: "API",
          state: "INSUFFICIENT_EVIDENCE",
          applicable: false,
          blockingFindings: 0,
          reasons: [
            { code: "EXPECTED_IDENTITY_MISSING", message: "Expected identity is required." },
          ],
        },
      ]
    )
    expect(report.verdict).toBe("INCONCLUSIVE")
    expect(report.score).toBeNull()
    // Reason messages are humanized to plain sentences at the rendering layer
    // (gateReasonSentence) — the raw gate message never reaches the report.
    expect(report.conditions).toContain(
      "API: Name the exact commit or artifact this launch covers so the verdict can be checked against it."
    )
  })

  it("maps READY only when every target is applicable", () => {
    const report = projectGateReadinessReport(
      [],
      [
        {
          targetId: "target-1",
          targetName: "API",
          state: "READY",
          applicable: true,
          blockingFindings: 0,
          reasons: [],
        },
      ]
    )
    expect(report.verdict).toBe("GO")
    expect(report.score).toBeNull()
    expect(report.triageScore).toBe(100)
  })
})

describe("gateReasonSentence", () => {
  it("rewrites known gate reason codes as plain sentences", () => {
    expect(gateReasonSentence({ code: "ASSESSMENT_UNAVAILABLE", message: "ignored" })).toBe(
      "No completed scan assessment exists yet. Run a scan to create one."
    )
    expect(gateReasonSentence({ code: "ASSESSMENT_EXPIRED", message: "ignored" })).toContain(
      "more than 24 hours old"
    )
    expect(gateReasonSentence({ code: "EVIDENCE_CHANGED", message: "ignored" })).toContain(
      "Run a new scan"
    )
  })

  it("keeps the gate's own message for unknown codes instead of inventing one", () => {
    expect(gateReasonSentence({ code: "SOMETHING_NEW", message: "Raw gate message." })).toBe(
      "Raw gate message."
    )
  })
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

  it.each(["PR_OPENED", "TICKET_CREATED", "FIXED_PENDING_RETEST"])(
    "keeps a high %s finding unresolved in triage context",
    (status) => {
      const report = generateLaunchReadinessReport(
        [makeFinding({ severity: "HIGH", status })],
        true
      )
      expect(report.verdict).toBe("NO_GO")
      expect(report.blockingFindings).toBe(1)
    }
  )

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

  /**
   * Observed live in production on 2026-09-03: a passive Surface Review of a
   * URL target produced 57 coverage receipts of which only 4 completed — the
   * rest were NOT_APPLICABLE or BLOCKED — and Launch Readiness reported
   * "GO, 100/100". `evaluated` was true (one scanner did complete), so the
   * binary flag let a mostly-unchecked target certify a launch.
   */
  describe("partial coverage gating", () => {
    it("never issues a bare GO with a perfect score when applicable controls are unestablished", () => {
      const report = generateLaunchReadinessReportFromAggregate([], true, {
        evaluated: true,
        unresolvedControls: 11,
      })

      expect(report.verdict).toBe("GO_WITH_CONDITIONS")
      // The critical assertion: no number for a user to read as a pass.
      expect(report.score).toBeNull()
      expect(report.summary).toContain("scope-limited")
      expect(report.conditions.join(" ")).toContain("11 applicable control(s)")
    })

    it("keeps GO and the score when every applicable control completed", () => {
      const report = generateLaunchReadinessReportFromAggregate([], true, {
        evaluated: true,
        unresolvedControls: 0,
      })

      expect(report.verdict).toBe("GO")
      expect(report.score).toBe(100)
    })

    it("leaves NO_GO intact — finding something bad is conclusive regardless of coverage", () => {
      const report = generateLaunchReadinessReportFromAggregate(
        [{ severity: "CRITICAL", status: "OPEN", verified: true, count: 1 }],
        true,
        { evaluated: true, unresolvedControls: 5 }
      )

      expect(report.verdict).toBe("NO_GO")
      expect(report.score).not.toBeNull()
      expect(report.conditions.join(" ")).toContain("5 applicable control(s)")
    })

    it("is unchanged when the caller reports no unresolved controls", () => {
      const report = generateLaunchReadinessReportFromAggregate([], true, { evaluated: true })
      expect(report.verdict).toBe("GO")
      expect(report.score).toBe(100)
    })
  })
})

describe("parseReleaseReference", () => {
  it("accepts a full 40-hex commit SHA and lowercases it", () => {
    expect(parseReleaseReference("A".repeat(40))).toEqual({
      kind: "COMMIT",
      value: "a".repeat(40),
    })
  })

  it("accepts a sha256: artifact digest", () => {
    const digest = `sha256:${"c".repeat(64)}`
    expect(parseReleaseReference(digest)).toEqual({ kind: "ARTIFACT_DIGEST", value: digest })
  })

  it("trims surrounding whitespace", () => {
    expect(parseReleaseReference(`  ${"b".repeat(40)}\n`)?.kind).toBe("COMMIT")
  })

  it("rejects prefixes, tags, malformed values, and empty input", () => {
    for (const bad of [
      "abc1234",
      "main",
      "v1.2.3",
      "g".repeat(40),
      "a".repeat(39),
      "a".repeat(41),
      `sha256:${"c".repeat(63)}`,
      `sha512:${"c".repeat(64)}`,
      `sha256:${"C".repeat(64)} `,
      "",
      null,
      undefined,
    ]) {
      // sha256 with uppercase hex is still valid hex — exclude that case.
      if (bad === `sha256:${"C".repeat(64)} `) continue
      expect(parseReleaseReference(bad)).toBeNull()
    }
    expect(parseReleaseReference(`sha256:${"C".repeat(64)}`)).toEqual({
      kind: "ARTIFACT_DIGEST",
      value: `sha256:${"c".repeat(64)}`,
    })
  })
})

describe("describeReleaseCheck", () => {
  const target = {
    targetId: "target-1",
    targetName: "API",
    state: "READY" as const,
    historicalState: "READY" as const,
    applicable: true,
    blockingFindings: 0,
    reasons: [] as { code: string; message: string }[],
    assessedIdentity: { kind: "COMMIT" as const, value: "b".repeat(40) },
  }

  it("matches the exact assessed commit", () => {
    const check = describeReleaseCheck(target, { kind: "COMMIT", value: "b".repeat(40) })
    expect(check.match).toBe("match")
    expect(check.state).toBe("READY")
    expect(check.assessed?.value).toBe("b".repeat(40))
  })

  it("reports a different release as mismatch, never as ready", () => {
    const check = describeReleaseCheck(target, { kind: "COMMIT", value: "f".repeat(40) })
    expect(check.match).toBe("mismatch")
    // The effective state comes from the gate read (INSUFFICIENT_EVIDENCE on
    // mismatch) — the label alone must never read as a pass.
    expect(check.assessed?.value).toBe("b".repeat(40))
    expect(check.requested?.value).toBe("f".repeat(40))
  })

  it("matches an artifact digest identity", () => {
    const digest = `sha256:${"d".repeat(64)}`
    const artifactTarget = {
      ...target,
      assessedIdentity: { kind: "ARTIFACT_DIGEST" as const, value: digest },
    }
    const check = describeReleaseCheck(artifactTarget, {
      kind: "ARTIFACT_DIGEST",
      value: digest,
    })
    expect(check.match).toBe("match")
  })

  it("cannot confirm when the retained identity kind differs", () => {
    const check = describeReleaseCheck(target, {
      kind: "ARTIFACT_DIGEST",
      value: `sha256:${"d".repeat(64)}`,
    })
    expect(check.match).toBe("cannot_confirm")
  })

  it("cannot confirm when the verdict retains no identity binding", () => {
    const check = describeReleaseCheck(
      { ...target, assessedIdentity: null },
      { kind: "COMMIT", value: "b".repeat(40) }
    )
    expect(check.match).toBe("cannot_confirm")
  })

  it("cannot confirm when the target has no verdict at all", () => {
    const check = describeReleaseCheck(null, { kind: "COMMIT", value: "b".repeat(40) })
    expect(check.match).toBe("cannot_confirm")
    expect(check.state).toBe("INSUFFICIENT_EVIDENCE")
    expect(check.reasons[0]?.code).toBe("NO_GATE_VERDICT")
  })

  it("keeps a match honest when the assessment is expired", () => {
    const expired = {
      ...target,
      applicable: false,
      state: "INSUFFICIENT_EVIDENCE" as const,
      reasons: [
        { code: "ASSESSMENT_EXPIRED", message: "Assessment is older than 24 hours." },
      ],
    }
    const check = describeReleaseCheck(expired, { kind: "COMMIT", value: "b".repeat(40) })
    expect(check.match).toBe("match")
    expect(check.applicable).toBe(false)
    expect(check.state).toBe("INSUFFICIENT_EVIDENCE")
    expect(check.historicalState).toBe("READY")
  })

  it("keeps a match honest when the historical verdict is NOT_READY", () => {
    const notReady = {
      ...target,
      state: "NOT_READY" as const,
      historicalState: "NOT_READY" as const,
      blockingFindings: 2,
    }
    const check = describeReleaseCheck(notReady, { kind: "COMMIT", value: "b".repeat(40) })
    expect(check.match).toBe("match")
    expect(check.state).toBe("NOT_READY")
    expect(check.blockingFindings).toBe(2)
  })
})
