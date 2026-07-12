export const SCORE_MODEL_VERSION = "lyrashield-score/1.0.0"

export type ScoreGrade = "A_PLUS" | "A" | "B" | "C" | "D" | "F"
export type ScoreSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
export type ScoreStatus =
  | "OPEN"
  | "FIX_READY"
  | "PR_OPENED"
  | "TICKET_CREATED"
  | "FIXED_PENDING_RETEST"
  | "FIXED"
  | "ACCEPTED_RISK"
  | "FALSE_POSITIVE"
  | "DUPLICATE"

export interface FindingInput {
  severity: ScoreSeverity
  status: ScoreStatus
  verified: boolean
  /** True only for a currently active verified secret-scanner result. */
  activeSecret?: boolean
}

export interface ScanInput {
  mode: "SAFE" | "QUICK" | "STANDARD" | "DEEP" | "CUSTOM"
  isDefaultBranch: boolean
}

export interface ScoreBreakdown {
  deductions: Record<ScoreSeverity, number>
  eligibleFindings: number
  acceptedRiskFindings: number
  openMediumOrHigher: number
  activeVerifiedSecret: boolean
}

export interface ScoreResult {
  score: number
  grade: ScoreGrade
  breakdown: ScoreBreakdown
  shareEligible: boolean
}

const WEIGHTS: Record<ScoreSeverity, number> = {
  CRITICAL: 25,
  HIGH: 10,
  MEDIUM: 4,
  LOW: 1,
  INFO: 0,
}

const OPEN = new Set<ScoreStatus>([
  "OPEN",
  "FIX_READY",
  "PR_OPENED",
  "TICKET_CREATED",
  "FIXED_PENDING_RETEST",
])

function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5)
}

function band(score: number): ScoreGrade {
  if (score >= 98) return "A_PLUS"
  if (score >= 90) return "A"
  if (score >= 80) return "B"
  if (score >= 65) return "C"
  if (score >= 50) return "D"
  return "F"
}

function capGrade(grade: ScoreGrade, maximum: ScoreGrade): ScoreGrade {
  const rank: Record<ScoreGrade, number> = { A_PLUS: 6, A: 5, B: 4, C: 3, D: 2, F: 1 }
  return rank[grade] > rank[maximum] ? maximum : grade
}

/** Pure and versioned: the database layer owns persistence, never score math. */
export function computeScore(findings: FindingInput[], scan: ScanInput): ScoreResult {
  const deductions: Record<ScoreSeverity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    INFO: 0,
  }
  let eligibleFindings = 0
  let acceptedRiskFindings = 0
  let openMediumOrHigher = 0
  let verifiedCritical = false
  let verifiedHigh = false
  let activeVerifiedSecret = false

  for (const finding of findings) {
    const open = OPEN.has(finding.status)
    const acceptedRisk = finding.status === "ACCEPTED_RISK"
    if (!open && !acceptedRisk) continue

    eligibleFindings++
    if (acceptedRisk) acceptedRiskFindings++
    if (
      open &&
      (finding.severity === "CRITICAL" ||
        finding.severity === "HIGH" ||
        finding.severity === "MEDIUM")
    ) {
      openMediumOrHigher++
    }

    const multiplier = (finding.verified ? 1 : 0.25) * (acceptedRisk ? 0.5 : 1)
    deductions[finding.severity] += WEIGHTS[finding.severity] * multiplier
    if (open && finding.verified && finding.severity === "CRITICAL") verifiedCritical = true
    if (open && finding.verified && finding.severity === "HIGH") verifiedHigh = true
    if (open && finding.verified && finding.activeSecret) activeVerifiedSecret = true
  }

  const score = Math.max(
    0,
    roundHalfUp(100 - Object.values(deductions).reduce((sum, value) => sum + value, 0))
  )
  let grade = band(score)
  if (grade === "A_PLUS" && openMediumOrHigher > 0) grade = "A"
  if (verifiedCritical) grade = capGrade(grade, "C")
  if (verifiedHigh) grade = capGrade(grade, "B")
  if (activeVerifiedSecret) grade = capGrade(grade, "D")

  return {
    score,
    grade,
    breakdown: {
      deductions,
      eligibleFindings,
      acceptedRiskFindings,
      openMediumOrHigher,
      activeVerifiedSecret,
    },
    shareEligible: (scan.mode === "STANDARD" || scan.mode === "DEEP") && scan.isDefaultBranch,
  }
}
