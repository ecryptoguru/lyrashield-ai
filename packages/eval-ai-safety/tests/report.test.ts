import { describe, it, expect } from "vitest"
import { generateMarkdownReport, generateJsonReport, runOwaspSuite } from "../src/index.js"
import type { EvaluationResult } from "../src/index.js"

describe("Report generators", () => {
  const sampleResult: EvaluationResult = {
    suite: "owasp_genai_red_team",
    frameworkVersion: "test v1.0",
    runAt: "2026-08-13T12:00:00.000Z",
    guardConfig: { maxInputLength: 10000, strictMode: true, timeoutMs: 1000 },
    categories: [
      {
        category: "Model Evaluation",
        total: 12,
        blocked: 9,
        sanitized: 0,
        allowed: 3,
        blockRate: 75,
        sanitizeRate: 0,
        expectedOutcomes: 11,
        expectedOutcomeRate: 91.7,
      },
    ],
    totals: {
      total: 12,
      blocked: 9,
      sanitized: 0,
      allowed: 3,
      blockRate: 75,
      sanitizeRate: 0,
      expectedOutcomes: 11,
      expectedOutcomeRate: 91.7,
    },
  }

  it("generates a Markdown report with all sections", () => {
    const md = generateMarkdownReport(sampleResult)
    expect(md).toContain("# AI Safety Evaluation Report")
    expect(md).toContain("Overall results")
    expect(md).toContain("Per-category results")
    expect(md).toContain("Methodology")
    expect(md).toContain("Limitations")
    expect(md).toContain("Expected outcomes matched")
  })

  it("generates valid JSON", () => {
    const json = generateJsonReport(sampleResult)
    const parsed = JSON.parse(json)
    expect(parsed.suite).toBe("owasp_genai_red_team")
    expect(parsed.totals.total).toBe(12)
  })

  it("includes OWASP methodology text for OWASP suite", () => {
    const md = generateMarkdownReport(sampleResult)
    expect(md).toContain("OWASP Gen AI Red Teaming Guide")
    expect(md).toContain("Model evaluation")
  })

  it("includes AILuminate methodology text for AILuminate suite", () => {
    const ailuminateResult: EvaluationResult = {
      ...sampleResult,
      suite: "mlcommons_ailuminate_demo",
      frameworkVersion: "AILuminate v1.0 Demo",
      categories: sampleResult.categories.map((category) => ({
        ...category,
        expectedOutcomes: null,
        expectedOutcomeRate: null,
      })),
      totals: { ...sampleResult.totals, expectedOutcomes: null, expectedOutcomeRate: null },
    }
    const md = generateMarkdownReport(ailuminateResult)
    expect(md).toContain("MLCommons AILuminate")
    expect(md).toContain("NOT an MLCommons-certified result")
    expect(md).toContain("Not scored")
  })

  it("generates a real report from the OWASP runner", () => {
    const result = runOwaspSuite()
    const md = generateMarkdownReport(result)
    expect(md).toContain("Expected outcomes matched")
    expect(md).toContain("Implementation Testing")
    expect(md).toContain("Runtime Behavior")
  })
})
