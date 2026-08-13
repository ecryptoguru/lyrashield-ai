/**
 * OWASP Gen AI Red Teaming Guide evaluation runner.
 *
 * Runs the OWASP test cases against the PromptInjectionGuard and produces
 * per-area and overall results.
 */
import { PromptInjectionGuard } from "@lyrashield/mcp"
import type {
  EvaluationResult,
  CategoryResult,
  TestCaseResult,
  GuardOutcome,
  OwaspArea,
} from "../types.js"
import { OWASP_TEST_CASES } from "./test-cases.js"

const OWASP_AREA_LABELS: Record<OwaspArea, string> = {
  model_evaluation: "Model Evaluation",
  implementation_testing: "Implementation Testing",
  infrastructure_assessment: "Infrastructure Assessment",
  runtime_behavior: "Runtime Behavior Analysis",
}

/**
 * Determine the guard outcome from a GuardResult.
 */
function classifyOutcome(result: ReturnType<PromptInjectionGuard["check"]>): GuardOutcome {
  if (!result.allowed) return "blocked"
  if (result.sanitizedInput) return "sanitized"
  return "allowed"
}

/**
 * Check whether the actual patterns match the expected patterns (subset check).
 */
function patternsMatch(actual: string[], expected?: string[]): boolean {
  if (!expected || expected.length === 0) return true
  return expected.every((p) => actual.includes(p))
}

/**
 * Run the OWASP Gen AI Red Teaming test suite.
 */
export function runOwaspSuite(guard?: PromptInjectionGuard): EvaluationResult {
  const g = guard ?? new PromptInjectionGuard()
  const cases: TestCaseResult[] = []
  const areaOrder: OwaspArea[] = [
    "model_evaluation",
    "implementation_testing",
    "infrastructure_assessment",
    "runtime_behavior",
  ]

  for (const tc of OWASP_TEST_CASES) {
    const start = Date.now()
    const result = g.check(tc.input)
    const durationMs = Date.now() - start
    const outcome = classifyOutcome(result)

    // For "allowed" expected outcomes, the test passes if the guard allows.
    // For "blocked" expected outcomes, the test passes if the guard blocks
    // AND the expected patterns are a subset of detected patterns.
    const expected =
      outcome === tc.expectedOutcome &&
      (tc.expectedOutcome === "allowed"
        ? true
        : patternsMatch(result.detectedPatterns, tc.expectedPatterns))

    cases.push({
      id: tc.id,
      input: tc.input.length > 200 ? tc.input.slice(0, 200) + "…" : tc.input,
      detectedPatterns: result.detectedPatterns,
      outcome,
      reason: result.reason,
      sanitizedInput: result.sanitizedInput
        ? result.sanitizedInput.length > 200
          ? result.sanitizedInput.slice(0, 200) + "…"
          : result.sanitizedInput
        : undefined,
      durationMs,
      expected,
    })
  }

  // Aggregate by area.
  const categories: CategoryResult[] = areaOrder.map((area) => {
    const areaCases = cases.filter((c) => {
      const tc = OWASP_TEST_CASES.find((t) => t.id === c.id)
      return tc?.area === area
    })
    return aggregateCategory(OWASP_AREA_LABELS[area], areaCases)
  })

  const totals = aggregateTotals(cases)

  return {
    suite: "owasp_genai_red_team",
    frameworkVersion:
      "OWASP Gen AI Red Teaming Guide (Jan 2025) + Vendor Eval Criteria v1.0 (Feb 2026)",
    runAt: new Date().toISOString(),
    guardConfig: {
      maxInputLength: g["maxInputLength"],
      strictMode: g["strictMode"],
      timeoutMs: g["timeoutMs"],
    },
    categories,
    totals,
    cases,
  }
}

function aggregateCategory(category: string, cases: TestCaseResult[]): CategoryResult {
  const total = cases.length
  const blocked = cases.filter((c) => c.outcome === "blocked").length
  const sanitized = cases.filter((c) => c.outcome === "sanitized").length
  const allowed = cases.filter((c) => c.outcome === "allowed").length
  const expectedOutcomes = cases.filter((c) => c.expected === true).length
  return {
    category,
    total,
    blocked,
    sanitized,
    allowed,
    blockRate: total > 0 ? (blocked / total) * 100 : 0,
    sanitizeRate: total > 0 ? (sanitized / total) * 100 : 0,
    expectedOutcomes,
    expectedOutcomeRate: total > 0 ? (expectedOutcomes / total) * 100 : 0,
  }
}

function aggregateTotals(cases: TestCaseResult[]): EvaluationResult["totals"] {
  const total = cases.length
  const blocked = cases.filter((c) => c.outcome === "blocked").length
  const sanitized = cases.filter((c) => c.outcome === "sanitized").length
  const allowed = cases.filter((c) => c.outcome === "allowed").length
  const expectedOutcomes = cases.filter((c) => c.expected === true).length
  return {
    total,
    blocked,
    sanitized,
    allowed,
    blockRate: total > 0 ? (blocked / total) * 100 : 0,
    sanitizeRate: total > 0 ? (sanitized / total) * 100 : 0,
    expectedOutcomes,
    expectedOutcomeRate: total > 0 ? (expectedOutcomes / total) * 100 : 0,
  }
}
