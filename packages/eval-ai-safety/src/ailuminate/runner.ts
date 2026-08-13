/**
 * MLCommons AILuminate demo evaluation runner.
 *
 * Runs the 1,200 CC-BY-4.0 demo prompts through the PromptInjectionGuard
 * and produces per-hazard-category and overall results.
 *
 * IMPORTANT: This evaluates the GUARD, not the LLM. The guard is a
 * deterministic regex-based filter that gates inputs before they reach
 * the scan engine. A "blocked" result means the LLM never sees the prompt.
 * An "allowed" result means the LLM's own safety training is the last
 * line of defense.
 *
 * This records guard outcomes as an observational scope check. It does not
 * assign a safety grade because this suite has no prompt-injection oracle.
 * The demo set is for internal testing only; results are not publishable
 * with the MLCommons name or trademark.
 */
import { PromptInjectionGuard } from "@lyrashield/mcp"
import type {
  EvaluationResult,
  CategoryResult,
  TestCaseResult,
  GuardOutcome,
  AiluminateHazard,
} from "../types.js"
import { loadDemoSet, getDefaultCsvPath } from "./loader.js"

const HAZARD_LABELS: Record<AiluminateHazard, string> = {
  cse: "Child Sexual Exploitation",
  ddh: "Deception & Disinformation (Harmful)",
  hat: "Hate & Toxic Speech",
  nhw: "Non-consensual Harassment & Violence",
  shv: "Self-Harm & Violence",
  ssh: "Sexual Safety & Harassment",
  iv: "Intrusion & Violation",
  def: "Defamation",
  ide: "Ideological & Extremist Content",
  ncr: "Non-consensual Sexual Content (Real)",
  sxc: "Sexual Content (Consensual but Inappropriate)",
  bck: "Bullying & Cyberbullying/Kids",
}

const HAZARD_ORDER: AiluminateHazard[] = [
  "cse",
  "ddh",
  "hat",
  "nhw",
  "shv",
  "ssh",
  "iv",
  "def",
  "ide",
  "ncr",
  "sxc",
  "bck",
]

function classifyOutcome(result: ReturnType<PromptInjectionGuard["check"]>): GuardOutcome {
  if (!result.allowed) return "blocked"
  if (result.sanitizedInput) return "sanitized"
  return "allowed"
}

/**
 * Run the MLCommons AILuminate demo evaluation.
 *
 * @param guard Optional pre-configured guard. Defaults to a standard guard.
 * @param csvPath Optional path to the demo CSV. Defaults to the cached path.
 * @param options Optional settings (e.g., includeCases for detailed output).
 */
export function runAiluminateSuite(
  guard?: PromptInjectionGuard,
  csvPath?: string,
  options?: { includeCases?: boolean }
): EvaluationResult {
  const g = guard ?? new PromptInjectionGuard()
  const path = csvPath ?? getDefaultCsvPath()
  const prompts = loadDemoSet(path)

  const cases: TestCaseResult[] = []
  const hazardGroups = new Map<AiluminateHazard, TestCaseResult[]>()

  for (const prompt of prompts) {
    const start = Date.now()
    const result = g.check(prompt.promptText)
    const durationMs = Date.now() - start
    const outcome = classifyOutcome(result)

    const tc: TestCaseResult = {
      id: prompt.releasePromptId,
      input:
        prompt.promptText.length > 200 ? prompt.promptText.slice(0, 200) + "…" : prompt.promptText,
      detectedPatterns: result.detectedPatterns,
      outcome,
      reason: result.reason,
      sanitizedInput: result.sanitizedInput
        ? result.sanitizedInput.length > 200
          ? result.sanitizedInput.slice(0, 200) + "…"
          : result.sanitizedInput
        : undefined,
      durationMs,
    }

    cases.push(tc)

    const group = hazardGroups.get(prompt.hazard) ?? []
    group.push(tc)
    hazardGroups.set(prompt.hazard, group)
  }

  // Aggregate by hazard category.
  const categories: CategoryResult[] = HAZARD_ORDER.filter((h) => hazardGroups.has(h)).map(
    (hazard) => {
      const hazardCases = hazardGroups.get(hazard)!
      return aggregateCategory(HAZARD_LABELS[hazard], hazardCases)
    }
  )

  const totals = aggregateTotals(cases)

  return {
    suite: "mlcommons_ailuminate_demo",
    frameworkVersion: "AILuminate v1.0 Demo (CC-BY-4.0, 1,200 prompts, 12 hazard categories)",
    runAt: new Date().toISOString(),
    guardConfig: {
      maxInputLength: g["maxInputLength"],
      strictMode: g["strictMode"],
      timeoutMs: g["timeoutMs"],
    },
    categories,
    totals,
    cases: options?.includeCases ? cases : undefined,
  }
}

function aggregateCategory(category: string, cases: TestCaseResult[]): CategoryResult {
  const total = cases.length
  const blocked = cases.filter((c) => c.outcome === "blocked").length
  const sanitized = cases.filter((c) => c.outcome === "sanitized").length
  const allowed = cases.filter((c) => c.outcome === "allowed").length
  return {
    category,
    total,
    blocked,
    sanitized,
    allowed,
    blockRate: total > 0 ? (blocked / total) * 100 : 0,
    sanitizeRate: total > 0 ? (sanitized / total) * 100 : 0,
    expectedOutcomes: null,
    expectedOutcomeRate: null,
  }
}

function aggregateTotals(cases: TestCaseResult[]): EvaluationResult["totals"] {
  const total = cases.length
  const blocked = cases.filter((c) => c.outcome === "blocked").length
  const sanitized = cases.filter((c) => c.outcome === "sanitized").length
  const allowed = cases.filter((c) => c.outcome === "allowed").length
  return {
    total,
    blocked,
    sanitized,
    allowed,
    blockRate: total > 0 ? (blocked / total) * 100 : 0,
    sanitizeRate: total > 0 ? (sanitized / total) * 100 : 0,
    expectedOutcomes: null,
    expectedOutcomeRate: null,
  }
}
