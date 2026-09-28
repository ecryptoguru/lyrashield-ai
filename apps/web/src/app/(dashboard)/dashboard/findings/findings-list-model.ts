import { calculateFindingPriority, type FindingPriorityResult } from "@/lib/finding-priority"
import type { FindingStatus, TargetEnvironment } from "@lyrashield/types"
import { SEVERITY_ORDER } from "./finding-presentation"

export interface FindingListItem {
  id: string
  title: string
  summary: string
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  status: string
  verified: boolean
  verificationStatus: string
  verificationMethod?: string | null
  verificationReason?: string | null
  confidence: string
  cwe?: string | null
  cvssScore?: number | null
  businessImpact?: string | null
  exploitability?: string | null
  target?: { id: string; name: string; type: string; environment?: string | null } | null
  _count?: { evidence: number; fixProposals: number }
  firstSeenAt: string
  lastSeenAt: string
  priority?: FindingPriorityResult
}

export type SortMode = "priority" | "severity" | "newest"

export function sortFindings(findings: FindingListItem[], sortMode: SortMode): FindingListItem[] {
  // Client-side sort — priority first (the API-ranked page default), then
  // severity high-first, then newest. Each mode keeps its own tie-breakers so
  // ordering stays deterministic across accumulated pages.
  return [...findings].sort((a, b) => {
    if (sortMode === "priority") {
      return (
        (b.priority?.score ?? -1) - (a.priority?.score ?? -1) ||
        (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99) ||
        new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
      )
    }
    if (sortMode === "severity") {
      return (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
    }
    // newest = lastSeenAt desc
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
  })
}

export function updateFindingStatus(
  finding: FindingListItem,
  id: string,
  status: string
): FindingListItem {
  return finding.id === id
    ? {
        ...finding,
        status,
        priority: calculateFindingPriority({
          severity: finding.severity,
          status: status as FindingStatus,
          verified: finding.verified,
          confidence: finding.confidence,
          environment: (finding.target?.environment ?? null) as TargetEnvironment | null,
          businessImpact: finding.businessImpact,
          exploitability: finding.exploitability,
        }),
      }
    : finding
}
