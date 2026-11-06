import { type ReleasePacketFinding, type ReleasePacketPayload } from "@lyrashield/types"

interface ClassificationFinding {
  id: string
  dedupeKey: string
  title: string
  severity: string
  status: string
  verificationStatus: string
  sourceRevision: string | null
  baseCommit: string | null
  firstSeenAt: Date
  lastSeenAt: Date
  trustedRetest: boolean
  retestState: ReleasePacketFinding["retestState"]
  fixProposal: { status: string; baseCommit: string | null } | null
}

export interface ClassificationInput {
  findings: ClassificationFinding[]
  currentObservedKeys: Set<string>
  baselineObservedKeys: Set<string>
  currentScanStartedAt: Date
  assessedIdentity: { kind: "COMMIT" | "ARTIFACT_DIGEST"; value: string } | null
  uncertainCandidateCount: number
  detailLimit?: number
}

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
}

function proposalState(
  proposal: ClassificationFinding["fixProposal"],
  identity: ClassificationInput["assessedIdentity"]
): ReleasePacketFinding["proposalState"] {
  if (!proposal) return "none"
  if (!identity || identity.kind !== "COMMIT" || !proposal.baseCommit) return "unknown"
  return proposal.baseCommit.toLowerCase() === identity.value.toLowerCase() ? "current" : "stale"
}

/**
 * Deterministic remediation classification. Dedupe keys, never titles or
 * similarity guesses, define continuity. A FIXED finding is resolved only when
 * the caller supplies a trusted deterministic-retest receipt.
 */
export function classifyReleaseFindings(input: ClassificationInput): {
  counts: ReleasePacketPayload["remediation"]["counts"]
  findings: ReleasePacketFinding[]
  truncated: boolean
} {
  const rows: ReleasePacketFinding[] = []
  let newFindings = 0
  let recurringFindings = 0
  let resolvedFindings = 0
  let uncertainMatches = input.uncertainCandidateCount

  for (const finding of input.findings) {
    const observedCurrent = input.currentObservedKeys.has(finding.dedupeKey)
    let category: ReleasePacketFinding["category"]
    if (finding.status === "FIXED" && finding.trustedRetest) {
      category = "resolved"
      resolvedFindings++
    } else if (finding.status === "FIXED") {
      category = "uncertain"
      uncertainMatches++
    } else if (observedCurrent) {
      category = input.baselineObservedKeys.has(finding.dedupeKey) ? "recurring" : "new"
      if (category === "recurring") recurringFindings++
      else newFindings++
    } else if (finding.lastSeenAt >= input.currentScanStartedAt || finding.status === "DUPLICATE") {
      category = "uncertain"
      uncertainMatches++
    } else {
      continue
    }

    rows.push({
      category,
      findingId: finding.id,
      dedupeKey: finding.dedupeKey,
      title: finding.title.slice(0, 240),
      severity: finding.severity,
      status: finding.status,
      verificationStatus: finding.verificationStatus,
      sourceRevision: finding.sourceRevision,
      evidenceHref: `/dashboard/findings/${encodeURIComponent(finding.id)}`,
      retestState: finding.retestState,
      proposalState: proposalState(finding.fixProposal, input.assessedIdentity),
    })
  }

  rows.sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      a.findingId.localeCompare(b.findingId)
  )
  const detailLimit = Math.max(1, Math.min(input.detailLimit ?? 100, 200))
  return {
    counts: {
      newFindings,
      recurringFindings,
      resolvedFindings,
      uncertainMatches,
    },
    findings: rows.slice(0, detailLimit),
    truncated: rows.length > detailLimit,
  }
}
