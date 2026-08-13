import { describe, expect, it } from "vitest"
import { AI_SECURITY_CONTROLS } from "./controls"
import { computeAiSecurityScore, type AISecurityScoreInput } from "./score"
import { AI_SECURITY_SCORE_VERSION } from "./types"
import type { AISecurityCoverage, AISecuritySignal } from "./types"

const CONTROL_IDS = AI_SECURITY_CONTROLS.map((c) => c.id)

function signal(
  controlId: string,
  state: AISecuritySignal["state"],
  severity: AISecuritySignal["severity"] = "MEDIUM",
  file = "example.ts",
  line = 1,
  ruleId = "rule-1"
): AISecuritySignal {
  return {
    controlId: controlId as AISecuritySignal["controlId"],
    ruleId,
    owaspMapping: "LLM01:2025",
    state,
    severity,
    file,
    line,
    snippet: "...",
    remediation: "Fix it",
    evidenceSource: "deterministic",
    detectorVersion: "ai-app-security/2026-08-13.1",
    evidenceChecksum: "abc",
  }
}

function coverage(controlStates: Record<string, AISecuritySignal["state"]>): AISecurityCoverage {
  const controls: AISecurityCoverage["controls"] = {} as AISecurityCoverage["controls"]
  let assessedCount = 0
  let notAssessedCount = 0
  let detectedCount = 0
  let noFindingCount = 0
  let inconclusiveCount = 0

  for (const controlId of CONTROL_IDS) {
    const state = controlStates[controlId] ?? "NOT_ASSESSED"
    const assessed = state !== "NOT_ASSESSED"

    if (assessed) assessedCount++
    else notAssessedCount++
    if (state === "DETECTED") detectedCount++
    if (state === "NO_FINDING") noFindingCount++
    if (state === "INCONCLUSIVE") inconclusiveCount++

    controls[controlId as AISecuritySignal["controlId"]] = {
      controlId: controlId as AISecuritySignal["controlId"],
      state,
      assessed,
      evidenceSource: assessed ? "deterministic" : undefined,
      ruleIds: ["rule-1"],
      fileCount: 1,
      signalCount: 1,
    }
  }

  return {
    version: "ai-app-security/2026-08-13.1",
    totalControls: CONTROL_IDS.length,
    assessedCount,
    notAssessedCount,
    detectedCount,
    noFindingCount,
    inconclusiveCount,
    controls,
    limitsReached: [],
    unsupportedFiles: [],
    truncatedFiles: [],
  }
}

function score(
  input: Omit<AISecurityScoreInput, "ai03"> & Partial<Pick<AISecurityScoreInput, "ai03">>
) {
  return computeAiSecurityScore({
    ai03: { resolutionStatus: "COMPLETE", advisoryStatus: "COMPLETE", fresh: true },
    ...input,
  })
}

describe("computeAiSecurityScore", () => {
  it("returns null and a reason when fewer than 6 controls are assessed", () => {
    const states = Object.fromEntries(
      CONTROL_IDS.map((id, i) => [id, i < 4 ? "NO_FINDING" : "NOT_ASSESSED"])
    ) as Record<string, AISecuritySignal["state"]>

    const result = score({
      signals: [],
      coverage: coverage(states),
    })

    expect(result.score).toBeNull()
    expect(result.reason).toMatch(/minimum 6/)
  })

  it("returns 100 for a fully assessed clean repository", () => {
    const states = Object.fromEntries(CONTROL_IDS.map((id) => [id, "NO_FINDING"])) as Record<
      string,
      AISecuritySignal["state"]
    >

    const result = score({
      signals: [],
      coverage: coverage(states),
    })

    expect(result.score).toBe(100)
    expect(result.methodologyVersion).toBe(AI_SECURITY_SCORE_VERSION)
    expect(result.evidenceQuality.complete).toBe(8)
    expect(result.evidenceQuality.inconclusive).toBe(0)
  })

  it("deducts the highest severity for a control with a single detection", () => {
    const states = Object.fromEntries(CONTROL_IDS.map((id) => [id, "NO_FINDING"])) as Record<
      string,
      AISecuritySignal["state"]
    >
    states["AI-01"] = "DETECTED"

    const signals = [signal("AI-01", "DETECTED", "HIGH")]
    const result = score({ signals, coverage: coverage(states) })

    expect(result.score).toBe(100 - 12)
    expect(result.controlScores["AI-01"].primaryDeduction).toBe(12)
    expect(result.controlScores["AI-01"].totalDeduction).toBe(12)
  })

  it("deducts the correct weight for CRITICAL, MEDIUM, and LOW findings", () => {
    const states = Object.fromEntries(CONTROL_IDS.map((id) => [id, "NO_FINDING"])) as Record<
      string,
      AISecuritySignal["state"]
    >
    states["AI-02"] = "DETECTED"
    states["AI-04"] = "DETECTED"
    states["AI-08"] = "DETECTED"

    const signals = [
      signal("AI-02", "DETECTED", "CRITICAL"),
      signal("AI-04", "DETECTED", "MEDIUM"),
      signal("AI-08", "DETECTED", "LOW"),
    ]

    const result = score({ signals, coverage: coverage(states) })

    expect(result.score).toBe(100 - 20 - 7 - 3)
    expect(result.deductions.CRITICAL).toBe(20)
    expect(result.deductions.MEDIUM).toBe(7)
    expect(result.deductions.LOW).toBe(3)
  })

  it("adds no more than 25% of the primary deduction for additional distinct identities", () => {
    const states = Object.fromEntries(CONTROL_IDS.map((id) => [id, "NO_FINDING"])) as Record<
      string,
      AISecuritySignal["state"]
    >
    states["AI-01"] = "DETECTED"

    const signals: AISecuritySignal[] = [
      signal("AI-01", "DETECTED", "HIGH", "a.ts", 10, "rule-1"),
      signal("AI-01", "DETECTED", "HIGH", "a.ts", 20, "rule-2"),
      signal("AI-01", "DETECTED", "HIGH", "b.ts", 10, "rule-3"),
      signal("AI-01", "DETECTED", "HIGH", "b.ts", 30, "rule-4"),
    ]

    const result = score({ signals, coverage: coverage(states) })

    const ai01 = result.controlScores["AI-01"]
    expect(ai01.distinctIdentities).toBe(4)
    expect(ai01.additionalDeduction).toBe(Math.round(ai01.primaryDeduction * 0.25))
    expect(ai01.totalDeduction).toBe(ai01.primaryDeduction + ai01.additionalDeduction)
  })

  it("returns null and a reason when AI-03 is incomplete", () => {
    const states = Object.fromEntries(CONTROL_IDS.map((id) => [id, "NO_FINDING"])) as Record<
      string,
      AISecuritySignal["state"]
    >
    states["AI-03"] = "INCONCLUSIVE"

    const result = score({
      signals: [signal("AI-03", "INCONCLUSIVE", "MEDIUM")],
      coverage: coverage(states),
      ai03: { resolutionStatus: "PARTIAL", advisoryStatus: "COMPLETE", fresh: false },
    })

    expect(result.score).toBeNull()
    expect(result.reason).toMatch(/AI-03/)
  })

  it("does not score AI-03 merely because a stale input claims freshness", () => {
    const states = Object.fromEntries(CONTROL_IDS.map((id) => [id, "NO_FINDING"])) as Record<
      string,
      AISecuritySignal["state"]
    >
    states["AI-03"] = "INCONCLUSIVE"

    const result = score({
      signals: [signal("AI-03", "INCONCLUSIVE", "MEDIUM")],
      coverage: coverage(states),
      ai03: { resolutionStatus: "COMPLETE", advisoryStatus: "PARTIAL", fresh: true },
    })

    expect(result.score).toBeNull()
  })

  it("produces stable evidence quality counts", () => {
    const states = Object.fromEntries(
      CONTROL_IDS.map((id) => [
        id,
        id === "AI-01" ? "DETECTED" : id === "AI-03" ? "INCONCLUSIVE" : "NO_FINDING",
      ])
    ) as Record<string, AISecuritySignal["state"]>

    const result = score({
      signals: [signal("AI-01", "DETECTED", "HIGH")],
      coverage: coverage(states),
    })

    const total =
      result.evidenceQuality.complete +
      result.evidenceQuality.partial +
      result.evidenceQuality.inconclusive

    expect(total).toBe(result.assessedCount)
    expect(result.assessedCount).toBe(8)
  })

  it("does not include NOT_ASSESSED controls in evidence quality", () => {
    const states = Object.fromEntries(
      CONTROL_IDS.map((id, i) => [id, i < 6 ? "NO_FINDING" : "NOT_ASSESSED"])
    ) as Record<string, AISecuritySignal["state"]>

    const result = score({
      signals: [],
      coverage: coverage(states),
    })

    expect(result.score).toBe(100)
    expect(result.assessedCount).toBe(6)
    expect(result.evidenceQuality.complete).toBe(6)
  })

  it("keeps accepted risks scored but excludes only reasoned false positives", () => {
    const states = Object.fromEntries(CONTROL_IDS.map((id) => [id, "NO_FINDING"])) as Record<
      string,
      AISecuritySignal["state"]
    >
    states["AI-01"] = "DETECTED"
    states["AI-02"] = "DETECTED"
    states["AI-04"] = "DETECTED"

    const result = score({
      coverage: coverage(states),
      candidates: [
        {
          controlId: "AI-01",
          findingIdentity: "accepted",
          severity: "HIGH",
          evidenceState: "DETECTED",
          disposition: "ACCEPTED_RISK",
          dispositionReason: "Approved for this release",
        },
        {
          controlId: "AI-02",
          findingIdentity: "unreasoned-fp",
          severity: "MEDIUM",
          evidenceState: "DETECTED",
          disposition: "FALSE_POSITIVE",
          dispositionReason: " ",
        },
        {
          controlId: "AI-04",
          findingIdentity: "reasoned-fp",
          severity: "CRITICAL",
          evidenceState: "DETECTED",
          disposition: "FALSE_POSITIVE",
          dispositionReason: "Test fixture is not reachable in production.",
        },
      ],
    })

    expect(result.score).toBe(100 - 12 - 7)
  })

  it("does not deduct a retest-confirmed identity in its new scan", () => {
    const states = Object.fromEntries(CONTROL_IDS.map((id) => [id, "NO_FINDING"])) as Record<
      string,
      AISecuritySignal["state"]
    >
    states["AI-01"] = "DETECTED"
    const result = score({
      coverage: coverage(states),
      candidates: [
        {
          controlId: "AI-01",
          findingIdentity: "resolved",
          severity: "CRITICAL",
          evidenceState: "DETECTED",
          disposition: "RETEST_CONFIRMED",
          dispositionReason: null,
        },
      ],
    })

    expect(result.score).toBe(100)
  })
})
