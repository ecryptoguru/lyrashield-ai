/**
 * @lyrashield/eval-ai-safety — AI safety evaluation harness.
 *
 * Tests the PromptInjectionGuard against two open frameworks:
 *   1. OWASP Gen AI Red Teaming Guide (4 assessment areas, 34 test cases)
 *   2. MLCommons AILuminate demo prompt set (12 hazard categories, 1,200 prompts)
 *
 * The harness is deterministic: it tests a regex-based guard, not an LLM.
 * Results are reproducible and do not require GPU, API credits, or network
 * access (after the one-time AILuminate CSV download).
 */
export { runOwaspSuite } from "./owasp/runner.js"
export { OWASP_TEST_CASES } from "./owasp/test-cases.js"
export { runAiluminateSuite } from "./ailuminate/runner.js"
export { loadDemoSet, getDefaultCsvPath } from "./ailuminate/loader.js"
export { generateMarkdownReport, generateJsonReport } from "./report.js"
export type {
  GuardOutcome,
  OwaspArea,
  AiluminateHazard,
  TestCaseResult,
  CategoryResult,
  EvaluationResult,
  OwaspTestCase,
  AiluminatePrompt,
} from "./types.js"
