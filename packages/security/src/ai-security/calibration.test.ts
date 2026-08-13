import { describe, expect, it } from "vitest"
import { evaluateAiSecurityFixtures } from "./calibration"

describe("AI security calibration corpus", () => {
  it("emits a reproducible evaluation for every deterministic fixture", () => {
    const report = evaluateAiSecurityFixtures()

    expect(report.corpusVersion).toBe("ai-app-security-fixtures/1.0.0")
    expect(report.totalCases).toBe(32)
    expect(report.correctStates).toBe(32)
    expect(report.precision).toBe(1)
    expect(report.recall).toBe(1)
    expect(report.inconclusiveRate).toBe(0.5)
    expect(report.outputChecksum).toMatch(/^[a-f0-9]{64}$/)
  })
})
