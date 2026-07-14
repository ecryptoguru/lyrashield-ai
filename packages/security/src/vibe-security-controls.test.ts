import { describe, expect, it } from "vitest"
import {
  VIBE_SECURITY_CONTROLS,
  VIBE_SECURITY_COVERAGE_VERSION,
  buildVibeSecurityInstruction,
  summarizeVibeSecurityCoverage,
} from "./vibe-security-controls"

describe("Vibe Security 50 coverage contract", () => {
  it("contains exactly 50 uniquely ranked controls", () => {
    expect(VIBE_SECURITY_CONTROLS).toHaveLength(50)
    expect(new Set(VIBE_SECURITY_CONTROLS.map((control) => control.rank)).size).toBe(50)
    expect(VIBE_SECURITY_CONTROLS.map((control) => control.rank)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1)
    )
  })

  it("sends every machine-testable control to the engine", () => {
    const instruction = buildVibeSecurityInstruction("FULL_PENTEST")
    for (const control of VIBE_SECURITY_CONTROLS.filter(
      (candidate) => candidate.strategy !== "evidence"
    )) {
      expect(instruction).toContain(`${control.rank}. ${control.title}`)
    }
    expect(instruction).toContain(VIBE_SECURITY_COVERAGE_VERSION)
    expect(instruction).toContain("Report only evidence-backed findings")
  })

  it("keeps findings separate from controls that require external evidence", () => {
    const summary = summarizeVibeSecurityCoverage([
      { title: "SQL injection in search" },
      { title: "Missing Content-Security-Policy header" },
      { title: "Missing backup and recovery proof" },
    ])

    expect(summary.totalControls).toBe(50)
    expect(summary.machineControlsRequested).toBe(43)
    expect(summary.evidenceControlsRequired).toBe(7)
    expect(summary.matchedControlRanks).toEqual([11, 27, 36])
    expect(summary.evidenceControlRanks).toEqual([34, 35, 36, 43, 46, 48, 50])
  })
})
