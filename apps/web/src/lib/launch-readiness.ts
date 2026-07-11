import type { FindingSeverity, FindingStatus } from "@lyrashield/types"

export interface FindingForReadiness {
  id: string
  severity: FindingSeverity
  status: FindingStatus
  verified: boolean
  confidence: string
  category?: string | null
  cwe?: string | null
  title: string
  summary: string
}

export type ReadinessVerdict = "GO" | "GO_WITH_CONDITIONS" | "NO_GO"

export interface LaunchReadinessReport {
  verdict: ReadinessVerdict
  score: number
  summary: string
  blockingFindings: number
  totalFindings: number
  verifiedFindings: number
  bySeverity: Record<string, number>
  conditions: string[]
  recommendations: string[]
}

const SEVERITY_WEIGHTS: Record<string, number> = {
  CRITICAL: 100,
  HIGH: 50,
  MEDIUM: 20,
  LOW: 5,
  INFO: 0,
}

const BLOCKING_STATUSES = new Set<string>(["OPEN", "FIX_READY"])

export function generateLaunchReadinessReport(
  findings: FindingForReadiness[]
): LaunchReadinessReport {
  const total = findings.length
  const verified = findings.filter((f) => f.verified).length

  const bySeverity: Record<string, number> = {}
  let blockingFindings = 0
  let score = 100

  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1

    if (BLOCKING_STATUSES.has(f.status)) {
      const weight = SEVERITY_WEIGHTS[f.severity] ?? 0
      score -= weight
      if (f.severity === "CRITICAL" || f.severity === "HIGH") {
        blockingFindings++
      }
    }
  }

  score = Math.max(0, Math.min(100, score))

  let verdict: ReadinessVerdict
  const conditions: string[] = []
  const recommendations: string[] = []

  if (blockingFindings > 0) {
    verdict = "NO_GO"
    conditions.push(
      `${blockingFindings} unresolved critical/high finding(s) must be fixed before launch`
    )
  } else if (score >= 80) {
    verdict = "GO"
  } else if (score >= 40) {
    verdict = "GO_WITH_CONDITIONS"
    conditions.push("Address remaining medium-severity findings before production deployment")
  } else {
    verdict = "NO_GO"
    conditions.push("Security score too low for production launch")
  }

  if (total > 0 && verified === 0) {
    recommendations.push(
      "No findings have been verified — run a deeper scan to confirm vulnerabilities"
    )
  }

  if ((bySeverity.CRITICAL ?? 0) > 0) {
    recommendations.push(`${bySeverity.CRITICAL} critical finding(s) require immediate attention`)
  }

  if ((bySeverity.HIGH ?? 0) > 0) {
    recommendations.push(
      `${bySeverity.HIGH} high-severity finding(s) should be prioritized for remediation`
    )
  }

  const summary = `${total} finding(s) detected, ${verified} verified. Security score: ${score}/100. Verdict: ${verdict}.`

  return {
    verdict,
    score,
    summary,
    blockingFindings,
    totalFindings: total,
    verifiedFindings: verified,
    bySeverity,
    conditions,
    recommendations,
  }
}
