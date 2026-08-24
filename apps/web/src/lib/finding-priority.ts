import type { FindingSeverity, FindingStatus, TargetEnvironment } from "@lyrashield/types"

export type FindingPriorityBand = "urgent" | "high" | "normal" | "low"

export interface FindingPriorityResult {
  score: number
  band: FindingPriorityBand
  reasons: string[]
  limitations: string[]
}

// Named integer weights so the heuristic stays auditable and deterministic.
// Severity dominates; optional context can add at most 8 points, less than one
// severity step, so text presence can never flip the severity conclusion.
const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  CRITICAL: 60,
  HIGH: 45,
  MEDIUM: 30,
  LOW: 15,
  INFO: 5,
}

const ENVIRONMENT_WEIGHT: Record<TargetEnvironment, number> = {
  PRODUCTION: 10,
  STAGING: 4,
  PREVIEW: 2,
  LOCAL: 0,
}

const CONFIDENCE_WEIGHT: Record<string, number> = {
  high: 5,
  medium: 2,
  low: 0,
}

const TRUSTED_VERIFICATION_WEIGHT = 15
const BUSINESS_IMPACT_CONTEXT_WEIGHT = 4
const EXPLOITABILITY_CONTEXT_WEIGHT = 4
const RESOLVED_CAP = 20

const RESOLVED_REASON: Record<string, string> = {
  ACCEPTED_RISK: "Risk accepted",
  FALSE_POSITIVE: "False positive",
  DUPLICATE: "Duplicate",
  FIXED: "Fixed after retest",
}

const HEURISTIC_LIMITATION =
  "Priority is heuristic triage context, not proof of exploitability or reachability."

function nonBlank(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0
}

export function calculateFindingPriority(input: {
  severity: FindingSeverity
  status: FindingStatus
  verified: boolean
  confidence: string
  environment?: TargetEnvironment | null
  businessImpact?: string | null
  exploitability?: string | null
}): FindingPriorityResult {
  const reasons: string[] = []
  const limitations: string[] = [HEURISTIC_LIMITATION]

  const resolvedReason = RESOLVED_REASON[input.status]
  if (resolvedReason) {
    return {
      score: RESOLVED_CAP,
      band: "low",
      reasons: [resolvedReason],
      limitations,
    }
  }

  let score = SEVERITY_WEIGHT[input.severity]
  reasons.push(`${input.severity[0]}${input.severity.slice(1).toLowerCase()} severity`)

  if (input.verified) {
    score += TRUSTED_VERIFICATION_WEIGHT
    reasons.push("Trusted verification evidence")
  } else {
    limitations.push(
      "No trusted verification evidence; this is a detected finding, not independently verified."
    )
  }

  if (input.environment) {
    score += ENVIRONMENT_WEIGHT[input.environment]
    if (input.environment === "PRODUCTION") reasons.push("Production target")
  } else {
    limitations.push("Target environment is unknown; production exposure was not considered.")
  }

  const confidenceKey = (input.confidence ?? "").trim().toLowerCase()
  const confidenceWeight = CONFIDENCE_WEIGHT[confidenceKey]
  if (confidenceWeight === undefined) {
    limitations.push("Confidence signal is unknown; triage metadata is not proof.")
  } else {
    score += confidenceWeight
    if (confidenceKey === "high") reasons.push("High confidence triage signal")
  }

  if (nonBlank(input.businessImpact)) {
    score += BUSINESS_IMPACT_CONTEXT_WEIGHT
    reasons.push("Business impact context available")
  }
  if (nonBlank(input.exploitability)) {
    score += EXPLOITABILITY_CONTEXT_WEIGHT
    reasons.push("Exploitability context available")
  }

  score = Math.max(0, Math.min(100, score))
  const band: FindingPriorityBand = score >= 80 ? "urgent" : score >= 60 ? "high" : score >= 30 ? "normal" : "low"

  return { score, band, reasons, limitations }
}
