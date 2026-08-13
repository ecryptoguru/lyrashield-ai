import { describe, expect, it } from "vitest"
import { AI_SECURITY_FIXTURES, getFixturesByControl } from "./fixtures"
import { scanAiSecurityFiles, summarizeAiSecurityCoverage } from "./scan"
import type { AIControlId, AIScanLimits } from "./types"

const DEFAULT_LIMITS: AIScanLimits = {
  maxFiles: 25,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  maxWallTimeMs: 30_000,
}

describe("scanAiSecurityFiles", () => {
  it("returns NOT_ASSESSED for all controls when no files are provided", () => {
    const result = scanAiSecurityFiles([], { limits: DEFAULT_LIMITS })

    expect(result.signals).toHaveLength(8)
    expect(result.signals.every((signal) => signal.state === "NOT_ASSESSED")).toBe(true)
    expect(result.coverage.totalControls).toBe(8)
    expect(result.coverage.assessedCount).toBe(0)
    expect(result.coverage.notAssessedCount).toBe(8)
  })

  it("produces the expected state for every fixture", () => {
    for (const fixture of AI_SECURITY_FIXTURES) {
      const result = scanAiSecurityFiles([fixture.file], { limits: DEFAULT_LIMITS })

      const signal = result.signals.find((s) => s.controlId === fixture.controlId)
      expect(signal, `No signal for ${fixture.name}`).toBeDefined()
      if (!signal) continue

      expect(signal.state, `Wrong state for ${fixture.name}`).toBe(fixture.expectedState)
      expect(signal.ruleId).toBe(fixture.ruleId)
      expect(signal.detectorVersion).toMatch(/^ai-app-security\//)
    }
  })

  it("excludes AI-03 when includeControls omits it", () => {
    const fixture = getFixturesByControl("AI-01")[0]
    if (!fixture) throw new Error("Missing AI-01 fixture")

    const result = scanAiSecurityFiles([fixture.file], {
      limits: DEFAULT_LIMITS,
      includeControls: ["AI-01"],
    })

    const ai01 = result.signals.find((s) => s.controlId === "AI-01")
    expect(ai01?.state).toBe("DETECTED")

    const ai03 = result.signals.find((s) => s.controlId === "AI-03")
    expect(ai03?.state).toBe("NOT_ASSESSED")

    const coverage = result.coverage.controls["AI-03"]
    expect(coverage.state).toBe("NOT_ASSESSED")
    expect(coverage.assessed).toBe(false)
  })

  it("enforces maxFiles and produces a limit in coverage", () => {
    const fixtures = AI_SECURITY_FIXTURES.filter((f) => f.controlId === "AI-01").map((f) => f.file)
    const result = scanAiSecurityFiles(fixtures, {
      limits: { ...DEFAULT_LIMITS, maxFiles: 1 },
    })

    expect(result.provenance.limitsReached).toContain("max_files")
    expect(result.coverage.limitsReached).toContain("max_files")
  })

  it("summarizes coverage per control", () => {
    const signals = AI_SECURITY_FIXTURES.map((fixture) => {
      const result = scanAiSecurityFiles([fixture.file], { limits: DEFAULT_LIMITS })
      return result.signals.find((s) => s.controlId === fixture.controlId)
    }).filter((s): s is NonNullable<typeof s> => s !== undefined)

    const coverage = summarizeAiSecurityCoverage(signals, ["AI-01", "AI-02"] as AIControlId[], {
      limitsReached: [],
      unsupportedFiles: [],
      truncatedFiles: [],
    })

    expect(coverage.totalControls).toBe(2)
    expect(coverage.controls["AI-01"]).toBeDefined()
    expect(coverage.controls["AI-02"]).toBeDefined()
  })
})
