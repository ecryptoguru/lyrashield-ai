"use client"

import { ChevronDown } from "lucide-react"
import { Badge } from "@lyrashield/ui"
import { humanizeToken } from "@/lib/labels"
import type { ScanData } from "./scan-detail-types"

type CoverageReceipt = ScanData["integrity"]["coverage"][number]

/**
 * The per-control outcome summary and the 50-receipt disclosure. It was the
 * bottom half of ScanCoverageDetail and moved here unchanged so that section
 * stays inside the size ratchet. Same counts, same labels, same markup.
 */
export function ScanControlCoverageDetail({
  controlCoverage,
  controlOutcomeCounts,
}: {
  controlCoverage: CoverageReceipt[]
  controlOutcomeCounts: Record<string, number>
}) {
  if (controlCoverage.length === 0) return null

  return (
    <div className="mt-5 border-t pt-5">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Findings mapped", controlOutcomeCounts.DETECTED ?? 0, "danger"],
          ["No finding returned", controlOutcomeCounts.NO_FINDING ?? 0, "muted"],
          ["Evidence required", controlOutcomeCounts.EVIDENCE_REQUIRED ?? 0, "warning"],
          ["Inconclusive", controlOutcomeCounts.INCONCLUSIVE ?? 0, "warning"],
          ["Not applicable", controlOutcomeCounts.NOT_APPLICABLE ?? 0, "muted"],
        ].map(([label, count, variant]) => (
          <div key={String(label)} className="rounded-md border p-3">
            <p className="text-muted-foreground text-xs">{label}</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-lg font-semibold">{count}</span>
              <Badge variant={variant as "danger" | "success" | "warning" | "muted"}>{count}</Badge>
            </div>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground mt-3 text-xs">
        “No finding returned” means an applicable scanner completed without reporting this issue. It
        is not an independent verification or a security guarantee.
      </p>
      <p className="text-muted-foreground mt-2 text-xs">
        “Inconclusive” means the available evidence cannot establish a control outcome. It can
        follow an unfinished scan or an unassessed check or a missing engine control mapping; it
        must not be read as a clean result.
      </p>
      <details className="mt-4 rounded-md border">
        <summary className="hover:bg-muted/50 flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
          Review all 50 control receipts
          <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
        </summary>
        <div className="divide-y border-t">
          {controlCoverage.map((receipt) => {
            const rank = typeof receipt.metadata?.rank === "number" ? receipt.metadata.rank : null
            const title =
              typeof receipt.metadata?.title === "string"
                ? receipt.metadata.title
                : receipt.controlId
            const outcome =
              typeof receipt.metadata?.outcome === "string"
                ? receipt.metadata.outcome
                : receipt.status
            const badgeVariant =
              outcome === "DETECTED"
                ? "danger"
                : outcome === "NO_FINDING"
                  ? "muted"
                  : outcome === "NOT_APPLICABLE"
                    ? "muted"
                    : "warning"
            return (
              <div
                key={receipt.controlId}
                className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {rank ? `${rank}. ` : ""}
                    {title}
                  </p>
                  {receipt.reason && (
                    <p className="text-muted-foreground mt-1 text-xs">{receipt.reason}</p>
                  )}
                </div>
                <Badge variant={badgeVariant}>{humanizeToken(outcome)}</Badge>
              </div>
            )
          })}
        </div>
      </details>
    </div>
  )
}
