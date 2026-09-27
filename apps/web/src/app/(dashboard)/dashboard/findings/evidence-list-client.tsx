"use client"

import { useState } from "react"
import Link from "next/link"
import { ShieldAlert } from "lucide-react"
import { EmptyState, LoadMore, buttonVariants } from "@lyrashield/ui"
import type { z } from "zod"
import { apiGetPaginated } from "@/lib/api-client"
import { evidenceFindingItemSchema, evidenceFindingsPaginatedSchema } from "@/lib/api-schemas"
import { evidenceTypeLabel } from "@/lib/labels"
import { findingsHref } from "@/lib/finding-list-params"

type EvidenceFindingItem = z.infer<typeof evidenceFindingItemSchema>

export function EvidenceListClient({
  workspaceId,
  targetId,
  observedInScanId,
  initialData,
  initialNextCursor,
}: {
  workspaceId: string
  targetId?: string
  observedInScanId?: string
  initialData: EvidenceFindingItem[]
  initialNextCursor: string | null
}) {
  const [findings, setFindings] = useState(initialData)
  const [nextCursor, setNextCursor] = useState(initialNextCursor)

  if (findings.length === 0 && !nextCursor) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="No verified evidence yet"
        description="Verified and safely redacted evidence records will appear here."
        action={
          <Link href="/dashboard/scans" className={buttonVariants()}>
            Start a scan
          </Link>
        }
      />
    )
  }

  return (
    <div className="grid gap-3">
      {findings.map((finding) => (
        <Link
          key={finding.id}
          href={findingsHref({
            tab: "issues",
            finding: finding.id,
            ...(observedInScanId ? { scanId: observedInScanId } : {}),
            ...(targetId ? { target: targetId } : {}),
          })}
          className="group block rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:shadow-card-hover"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="truncate font-semibold tracking-tight group-hover:text-primary">
                {finding.title}
              </h3>
              <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">{finding.summary}</p>
              {finding.target && (
                <p className="text-muted-foreground mt-1 text-xs">{finding.target.name}</p>
              )}
            </div>
            <div className="shrink-0 text-right">
              <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                {finding._count.evidence} record{finding._count.evidence === 1 ? "" : "s"}
              </span>
              <p className="text-muted-foreground mt-1 text-xs">
                {evidenceTypeLabel(finding.evidence[0]?.type)}
              </p>
            </div>
          </div>
        </Link>
      ))}
      <LoadMore
        key={`${workspaceId}:${observedInScanId ?? ""}:${targetId ?? ""}`}
        cursor={nextCursor}
        onLoadMore={async (cursor) => {
          const params = new URLSearchParams({ workspaceId, cursor })
          if (targetId) params.set("targetId", targetId)
          if (observedInScanId) params.set("observedInScanId", observedInScanId)
          try {
            const result = await apiGetPaginated<EvidenceFindingItem>(
              "/api/findings/evidence",
              Object.fromEntries(params),
              { schema: evidenceFindingsPaginatedSchema }
            )
            return { items: result.items, nextCursor: result.nextCursor }
          } catch {
            throw new Error("Failed to load more evidence. Try again.")
          }
        }}
        onItems={(items) => setFindings((previous) => [...previous, ...items])}
        onNextCursor={setNextCursor}
      />
    </div>
  )
}
