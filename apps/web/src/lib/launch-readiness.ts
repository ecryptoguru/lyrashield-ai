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

export type ReadinessVerdict = "NOT_EVALUATED" | "GO" | "GO_WITH_CONDITIONS" | "NO_GO"

export interface LaunchReadinessReport {
  verdict: ReadinessVerdict
  score: number | null
  summary: string
  blockingFindings: number
  totalFindings: number
  verifiedFindings: number
  bySeverity: Record<string, number>
  conditions: string[]
  recommendations: string[]
}

export interface FindingReadinessAggregate {
  severity: FindingSeverity
  status: FindingStatus
  verified: boolean
  count: number
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
  findings: FindingForReadiness[],
  hasCompletedScan: boolean
): LaunchReadinessReport {
  const grouped = new Map<string, FindingReadinessAggregate>()
  for (const finding of findings) {
    const key = `${finding.severity}:${finding.status}:${finding.verified}`
    const current = grouped.get(key)
    if (current) current.count++
    else
      grouped.set(key, {
        severity: finding.severity,
        status: finding.status,
        verified: finding.verified,
        count: 1,
      })
  }
  return generateLaunchReadinessReportFromAggregate([...grouped.values()], hasCompletedScan)
}

export function generateLaunchReadinessReportFromAggregate(
  groups: FindingReadinessAggregate[],
  hasCompletedScan: boolean
): LaunchReadinessReport {
  const total = groups.reduce((sum, group) => sum + group.count, 0)
  const verified = groups.reduce((sum, group) => sum + (group.verified ? group.count : 0), 0)

  if (!hasCompletedScan) {
    return {
      verdict: "NOT_EVALUATED",
      score: null,
      summary:
        "No completed scan evidence is available. Run a scan before making a launch decision.",
      blockingFindings: 0,
      totalFindings: total,
      verifiedFindings: verified,
      bySeverity: {},
      conditions: ["Complete at least one security scan before launch"],
      recommendations: [],
    }
  }

  const bySeverity: Record<string, number> = {}
  let blockingFindings = 0
  let score = 100

  for (const group of groups) {
    bySeverity[group.severity] = (bySeverity[group.severity] ?? 0) + group.count

    if (BLOCKING_STATUSES.has(group.status)) {
      const weight = SEVERITY_WEIGHTS[group.severity] ?? 0
      score -= weight * group.count
      if (group.severity === "CRITICAL" || group.severity === "HIGH") {
        blockingFindings += group.count
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
