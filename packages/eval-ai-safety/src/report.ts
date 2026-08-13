/**
 * Report generators for AI safety evaluation results.
 *
 * Produces Markdown and JSON outputs suitable for:
 *   - Internal review (full JSON with per-case results)
 *   - Public publication (Markdown summary with methodology and per-category grades)
 */
import type { EvaluationResult } from "./types.js"

/**
 * Generate a JSON string from an evaluation result.
 */
export function generateJsonReport(result: EvaluationResult): string {
  return JSON.stringify(result, null, 2)
}

/**
 * Generate a Markdown report from an evaluation result.
 *
 * The report includes:
 *   - Suite name, framework version, and run date
 *   - Guard configuration
 *   - Overall results (block rate, sanitize rate, expected-outcome rate where defined)
 *   - Per-category results table
 *   - Methodology and limitations
 */
export function generateMarkdownReport(result: EvaluationResult): string {
  const lines: string[] = []

  lines.push(`# AI Safety Evaluation Report`)
  lines.push("")
  lines.push(`**Suite:** ${suiteLabel(result.suite)}`)
  lines.push(`**Framework:** ${result.frameworkVersion}`)
  lines.push(`**Run date:** ${result.runAt}`)
  lines.push(
    `**Guard config:** maxInputLength=${result.guardConfig.maxInputLength}, strictMode=${result.guardConfig.strictMode}, timeoutMs=${result.guardConfig.timeoutMs}`
  )
  lines.push("")

  // Overall results
  lines.push("## Overall results")
  lines.push("")
  lines.push("| Metric | Value |")
  lines.push("|---|---|")
  lines.push(`| Total prompts | ${result.totals.total} |`)
  lines.push(
    `| Blocked by guard | ${result.totals.blocked} (${result.totals.blockRate.toFixed(1)}%) |`
  )
  lines.push(
    `| Sanitized by guard | ${result.totals.sanitized} (${result.totals.sanitizeRate.toFixed(1)}%) |`
  )
  lines.push(
    `| Allowed through | ${result.totals.allowed} (${(100 - result.totals.blockRate - result.totals.sanitizeRate).toFixed(1)}%) |`
  )
  if (result.totals.expectedOutcomeRate !== null) {
    lines.push(
      `| Expected outcomes matched | ${result.totals.expectedOutcomes}/${result.totals.total} (${result.totals.expectedOutcomeRate.toFixed(1)}%) |`
    )
  }
  lines.push("")

  // Per-category results
  lines.push("## Per-category results")
  lines.push("")
  lines.push(
    "| Category | Total | Blocked | Sanitized | Allowed | Block rate | Expected outcomes |"
  )
  lines.push("|---|---|---|---|---|---|---|")
  for (const cat of result.categories) {
    lines.push(
      `| ${cat.category} | ${cat.total} | ${cat.blocked} | ${cat.sanitized} | ${cat.allowed} | ${cat.blockRate.toFixed(1)}% | ${cat.expectedOutcomeRate === null ? "Not scored" : `${cat.expectedOutcomes}/${cat.total} (${cat.expectedOutcomeRate.toFixed(1)}%)`} |`
    )
  }
  lines.push("")

  // Methodology
  lines.push("## Methodology")
  lines.push("")
  if (result.suite === "owasp_genai_red_team") {
    lines.push(
      "The evaluation follows the OWASP Gen AI Red Teaming Guide (January 2025) and the OWASP Vendor Evaluation Criteria for AI Red Teaming Providers & Tooling v1.0 (February 2026). It covers four assessment areas:"
    )
    lines.push("")
    lines.push(
      "1. **Model evaluation** — adversarial prompts that test if the guard blocks harmful requests"
    )
    lines.push(
      "2. **Implementation testing** — bypass techniques against the guard (encoding, unicode, splitting, case variation)"
    )
    lines.push(
      "3. **Infrastructure assessment** — MCP transport and credential boundary tests via tool-call arguments"
    )
    lines.push(
      "4. **Runtime behavior analysis** — indirect prompt injection via scan-result descriptions"
    )
    lines.push("")
    lines.push(
      "Test cases are synthetic inputs that resemble attack patterns without containing actual harmful content. Each case has an expected outcome (blocked or allowed) and expected detection patterns."
    )
  } else if (result.suite === "mlcommons_ailuminate_demo") {
    lines.push(
      "The evaluation uses the MLCommons AILuminate v1.0 demo prompt set (1,200 prompts, CC-BY-4.0) across 12 hazard categories. Each prompt is sent to the PromptInjectionGuard; the guard's decision (blocked, sanitized, or allowed) is recorded."
    )
    lines.push("")
    lines.push(
      'The guard is a deterministic regex-based filter that gates MCP tool-call inputs before they reach the LLM scan engine. A "blocked" result means the LLM never sees the prompt. An "allowed" result means the LLM\'s own safety training is the last line of defense.'
    )
    lines.push("")
    lines.push(
      "**This is NOT an MLCommons-certified result.** The demo set is for internal testing only. Results are not publishable with the MLCommons name or trademark. The evaluation tests the guard, not the LLM."
    )
  }
  lines.push("")

  // Limitations
  lines.push("## Limitations")
  lines.push("")
  lines.push(
    "- This evaluation tests the PromptInjectionGuard, a deterministic regex-based filter. It does not test the LLM scan engine's own safety training."
  )
  lines.push(
    "- A high expected-outcome rate means this guard matched the declared outcomes in this finite corpus. It does **not** prove immunity to prompt injection attacks."
  )
  lines.push(
    "- Regex-based guards can be bypassed by novel techniques not covered by the existing patterns. This evaluation covers known attack patterns only."
  )
  lines.push(
    "- The AILuminate demo set is a 10% subset of the full practice set. The full set may reveal different results."
  )
  lines.push(
    "- This evaluation does not constitute certification, compliance, or a security guarantee."
  )
  lines.push("")

  return lines.join("\n")
}

function suiteLabel(suite: EvaluationResult["suite"]): string {
  if (suite === "owasp_genai_red_team") return "OWASP Gen AI Red Teaming Guide"
  if (suite === "mlcommons_ailuminate_demo") return "MLCommons AILuminate Demo"
  return suite
}
