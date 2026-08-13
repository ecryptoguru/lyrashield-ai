import { AI_SECURITY_SCORE_VERSION } from "./types"
import type {
  AIControlId,
  AISecurityCoverage,
  AISecuritySignal,
  AISecuritySignalState,
  AISecuritySeverity,
} from "./types"

export type AIScoreEvidenceQuality = {
  complete: number
  partial: number
  inconclusive: number
}

export type AIControlScore = {
  controlId: AIControlId
  primaryDeduction: number
  additionalDeduction: number
  totalDeduction: number
  assessed: boolean
  state: AISecuritySignalState
  distinctIdentities: number
}

/** Normalized, persisted-finding input. Triage metadata is deliberately absent. */
export type AIScoreCandidate = {
  controlId: AIControlId
  findingIdentity: string
  severity: AISecuritySeverity
  evidenceState: AISecuritySignalState
  disposition: "OPEN" | "ACCEPTED_RISK" | "FALSE_POSITIVE" | "RETEST_CONFIRMED"
  dispositionReason: string | null
}

export type AISecurityScoreInput = {
  /** Legacy deterministic input; callers should supply persisted candidates. */
  signals?: AISecuritySignal[]
  candidates?: AIScoreCandidate[]
  coverage: AISecurityCoverage
  ai03: {
    resolutionStatus: "COMPLETE" | "PARTIAL" | "UNSUPPORTED"
    advisoryStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE"
    fresh: boolean
  }
}

export type AISecurityScoreResult = {
  score: number | null
  methodologyVersion: string
  assessedCount: number
  totalControls: number
  evidenceQuality: AIScoreEvidenceQuality
  controlScores: Record<AIControlId, AIControlScore>
  deductions: {
    CRITICAL: number
    HIGH: number
    MEDIUM: number
    LOW: number
  }
  reason?: string
}

const SEVERITY_WEIGHTS: Record<AISecuritySeverity, number> = {
  CRITICAL: 20,
  HIGH: 12,
  MEDIUM: 7,
  LOW: 3,
}

const MIN_ASSESSED_CONTROLS = 6

function severityRank(a: AISecuritySeverity, b: AISecuritySeverity): number {
  const order: AISecuritySeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
  return order.indexOf(a) - order.indexOf(b)
}

function highestSeverity(severities: AISecuritySeverity[]): AISecuritySeverity | null {
  if (severities.length === 0) return null
  return severities.reduce((best, current) => (severityRank(current, best) < 0 ? current : best))
}

function candidatesFromSignals(signals: AISecuritySignal[]): AIScoreCandidate[] {
  return signals.map((signal) => ({
    controlId: signal.controlId,
    // Older callers expose only scanner signals. Keep their established
    // source-location identity until they pass persisted finding identities.
    findingIdentity: `${signal.evidenceChecksum}:${signal.ruleId}:${signal.file ?? ""}:${signal.line ?? 0}`,
    severity: signal.severity,
    evidenceState: signal.state,
    disposition: "OPEN",
    dispositionReason: null,
  }))
}

function isReasonedFalsePositive(candidate: AIScoreCandidate): boolean {
  return (
    candidate.disposition === "FALSE_POSITIVE" &&
    typeof candidate.dispositionReason === "string" &&
    candidate.dispositionReason.trim().length > 0
  )
}

export function computeAiSecurityScore(input: AISecurityScoreInput): AISecurityScoreResult {
  const { coverage, ai03 } = input
  const candidates = input.candidates ?? candidatesFromSignals(input.signals ?? [])

  const controlScores: Record<AIControlId, AIControlScore> = {} as Record<
    AIControlId,
    AIControlScore
  >
  const deductions = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }

  const evidenceQuality: AIScoreEvidenceQuality = { complete: 0, partial: 0, inconclusive: 0 }

  for (const controlId of Object.keys(coverage.controls) as AIControlId[]) {
    const controlCoverage = coverage.controls[controlId]
    const controlCandidates = candidates.filter((candidate) => candidate.controlId === controlId)
    const detectedCandidates = controlCandidates.filter(
      (candidate) =>
        candidate.evidenceState === "DETECTED" &&
        candidate.disposition !== "RETEST_CONFIRMED" &&
        !isReasonedFalsePositive(candidate)
    )
    const distinctIdentities = new Set(
      detectedCandidates.map((candidate) => candidate.findingIdentity)
    ).size

    const primarySeverity = highestSeverity(
      detectedCandidates.map((candidate) => candidate.severity)
    )
    const primaryDeduction = primarySeverity ? SEVERITY_WEIGHTS[primarySeverity] : 0

    const additionalDeduction = distinctIdentities > 1 ? Math.round(primaryDeduction * 0.25) : 0

    const totalDeduction = primaryDeduction + additionalDeduction

    controlScores[controlId] = {
      controlId,
      primaryDeduction,
      additionalDeduction,
      totalDeduction,
      assessed: controlCoverage.assessed,
      state: controlCoverage.state,
      distinctIdentities,
    }

    if (primarySeverity) {
      deductions[primarySeverity] += totalDeduction
    }

    if (!controlCoverage.assessed) {
      continue
    }

    if (controlCoverage.state === "INCONCLUSIVE") {
      evidenceQuality.inconclusive++
    } else if (controlCoverage.state === "DETECTED" || controlCoverage.state === "NO_FINDING") {
      const hasInconclusive = controlCandidates.some(
        (candidate) => candidate.evidenceState === "INCONCLUSIVE"
      )
      if (hasInconclusive) {
        evidenceQuality.partial++
      } else {
        evidenceQuality.complete++
      }
    }
  }

  const assessedCount = coverage.assessedCount

  let score: number | null = null
  let reason: string | undefined

  if (assessedCount < MIN_ASSESSED_CONTROLS) {
    reason = `Score unavailable — only ${assessedCount} of ${coverage.totalControls} controls were assessed (minimum ${MIN_ASSESSED_CONTROLS}).`
  } else if (
    ai03.resolutionStatus !== "COMPLETE" ||
    ai03.advisoryStatus !== "COMPLETE" ||
    !ai03.fresh
  ) {
    reason = "Score unavailable — AI-03 advisory data is stale or unresolved."
  } else if (coverage.limitsReached.length > 0) {
    reason = "Score unavailable — scanner limits prevented complete coverage."
  } else {
    const totalDeduction = Object.values(deductions).reduce((sum, value) => sum + value, 0)
    score = Math.max(0, 100 - totalDeduction)
  }

  return {
    score,
    methodologyVersion: AI_SECURITY_SCORE_VERSION,
    assessedCount,
    totalControls: coverage.totalControls,
    evidenceQuality,
    controlScores,
    deductions,
    reason,
  }
}
