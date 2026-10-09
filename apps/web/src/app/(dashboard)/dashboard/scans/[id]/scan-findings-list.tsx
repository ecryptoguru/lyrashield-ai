"use client"

import { ChevronDown, ChevronRight, Shield } from "lucide-react"
import { Badge, Card } from "@lyrashield/ui"
import { getVerificationStatusLabel } from "@/lib/enum-labels"
import { severityLabel } from "@/lib/labels"
import { SEVERITY_COLOR, SEVERITY_ICON, SEVERITY_ORDER } from "./scan-detail-presentation"
import type { FindingItem } from "./scan-detail-types"

/**
 * The severity counter row and the retained-findings cards. They were the
 * populated branch of ScanFindingsSection and moved here unchanged so that
 * section stays inside the size ratchet. Same counts, same order, same markup.
 */
export function ScanSeveritySummary({ findings }: { findings: FindingItem[] }) {
  const severityCounts = findings.reduce(
    (counts, finding) => {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1
      return counts
    },
    {} as Record<string, number>
  )

  return (
    <>
      {Object.entries(severityCounts)
        .sort(([a], [b]) => (SEVERITY_ORDER[a] ?? 99) - (SEVERITY_ORDER[b] ?? 99))
        .map(([sev, count]) => {
          const Icon = SEVERITY_ICON[sev] ?? Shield
          return (
            <span
              key={sev}
              className={`mr-3 inline-flex items-center gap-1 text-sm font-medium ${SEVERITY_COLOR[sev] ?? ""}`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {count} {severityLabel(sev)}
            </span>
          )
        })}
    </>
  )
}

export function ScanFindingCard({
  finding,
  isExpanded,
  onToggleFinding,
}: {
  finding: FindingItem
  isExpanded: boolean
  onToggleFinding: (id: string) => void
}) {
  const Icon = SEVERITY_ICON[finding.severity] ?? Shield

  return (
    <Card className="p-4">
      <button
        type="button"
        onClick={() => onToggleFinding(finding.id)}
        className="flex w-full items-start justify-between gap-3 text-left"
        aria-expanded={isExpanded}
        aria-controls={`finding-${finding.id}-detail`}
      >
        <div className="flex items-start gap-3">
          <Icon
            className={`mt-0.5 h-5 w-5 shrink-0 ${SEVERITY_COLOR[finding.severity] ?? ""}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="font-medium">{finding.title}</p>
            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="muted">{severityLabel(finding.severity)}</Badge>
              {finding.cwe && <span>CWE: {finding.cwe}</span>}
              {finding.cvssScore !== null && <span>CVSS: {finding.cvssScore}</span>}
              {finding.verified && <span className="text-emerald-600">Verified</span>}
              {!finding.verified && (
                <span>{getVerificationStatusLabel(finding.verificationStatus)}</span>
              )}
            </div>
          </div>
        </div>
        {isExpanded ? (
          <ChevronDown className="text-muted-foreground h-5 w-5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" aria-hidden="true" />
        )}
      </button>
      {isExpanded && (finding.summary || finding.verificationReason) && (
        <div
          id={`finding-${finding.id}-detail`}
          className="text-muted-foreground mt-3 border-t pt-3 text-sm"
        >
          {finding.summary && <p>{finding.summary}</p>}
          {finding.verificationReason && (
            <p className="mt-2 text-xs">{finding.verificationReason}</p>
          )}
        </div>
      )}
    </Card>
  )
}
