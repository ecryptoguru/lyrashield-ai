/**
 * Shared types for the AI safety evaluation harness.
 *
 * The harness tests the {@link PromptInjectionGuard} — a deterministic
 * regex-based filter that gates MCP tool-call inputs before they reach the
 * LLM scan engine. We are NOT testing an LLM directly; we are testing whether
 * the guard blocks, sanitizes, or allows each adversarial input.
 */

/** The three possible guard outcomes for any input. */
export type GuardOutcome = "blocked" | "sanitized" | "allowed"

/** The four OWASP Gen AI Red Teaming Guide assessment areas. */
export type OwaspArea =
  "model_evaluation" | "implementation_testing" | "infrastructure_assessment" | "runtime_behavior"

/** The 12 MLCommons AILuminate hazard categories. */
export type AiluminateHazard =
  "cse" | "ddh" | "hat" | "nhw" | "shv" | "ssh" | "iv" | "def" | "ide" | "ncr" | "sxc" | "bck"

/** A single test case result. */
export interface TestCaseResult {
  /** Stable identifier for the test case. */
  id: string
  /** The input that was tested. */
  input: string
  /** Which guard patterns were detected. */
  detectedPatterns: string[]
  /** The guard's decision. */
  outcome: GuardOutcome
  /** The guard's reason string, if any. */
  reason?: string
  /** The sanitized input, if the guard sanitized. */
  sanitizedInput?: string
  /** Time to evaluate in milliseconds. */
  durationMs: number
  /** Whether this outcome matched a declared oracle; absent for observational suites. */
  expected?: boolean
}

/** Aggregated results for one category. */
export interface CategoryResult {
  /** Category name (hazard category for AILuminate, area for OWASP). */
  category: string
  /** Total prompts in this category. */
  total: number
  /** Number blocked by the guard. */
  blocked: number
  /** Number sanitized (suspicious patterns detected, input modified). */
  sanitized: number
  /** Number allowed through. */
  allowed: number
  /** Block rate as a percentage (0–100). */
  blockRate: number
  /** Sanitize rate as a percentage (0–100). */
  sanitizeRate: number
  /** Cases that matched a declared expected outcome, or null for observational suites. */
  expectedOutcomes: number | null
  /** Expected-outcome match rate, or null for observational suites. */
  expectedOutcomeRate: number | null
}

/** Overall evaluation result. */
export interface EvaluationResult {
  /** Name of the evaluation suite. */
  suite: "owasp_genai_red_team" | "mlcommons_ailuminate_demo"
  /** Version of the evaluation framework. */
  frameworkVersion: string
  /** When the evaluation was run (ISO 8601). */
  runAt: string
  /** Guard configuration used. */
  guardConfig: {
    maxInputLength: number
    strictMode: boolean
    timeoutMs: number
  }
  /** Per-category results. */
  categories: CategoryResult[]
  /** Overall totals. */
  totals: {
    total: number
    blocked: number
    sanitized: number
    allowed: number
    blockRate: number
    sanitizeRate: number
    expectedOutcomes: number | null
    expectedOutcomeRate: number | null
  }
  /** Individual test case results (optional, for detailed reports). */
  cases?: TestCaseResult[]
}

/** A test case for the OWASP suite. */
export interface OwaspTestCase {
  id: string
  area: OwaspArea
  /** What the test case is checking. */
  description: string
  /** The input to send to the guard. */
  input: string
  /** The expected outcome. */
  expectedOutcome: GuardOutcome
  /** Expected patterns (subset check, not exact match). */
  expectedPatterns?: string[]
}

/** A row from the MLCommons AILuminate demo CSV. */
export interface AiluminatePrompt {
  releasePromptId: string
  promptText: string
  hazard: AiluminateHazard
  persona: string
  locale: string
  promptHash: string
}
