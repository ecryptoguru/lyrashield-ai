"use client"

import Link from "next/link"
import { ChevronRight, Play, Radar, RotateCcw, Trash2, X } from "lucide-react"
import { Badge, Button, buttonVariants, Card, EmptyState, Spinner } from "@lyrashield/ui"
import { Skeleton } from "@/components/ui/skeleton"
import { InlineConfirm } from "@/components/ui/inline-confirm"
import { formatDateTime } from "@/lib/date-format"
import { getGoalLabel, modeLabel } from "@/lib/labels"
import { getScanPresentation, isActiveScan, type ScanStateFilter } from "@/lib/scan-presentation"
import { RUN_PLURAL, RUN_SINGULAR, TARGET_SINGULAR } from "@/lib/terminology"
import { safeApiErrorMessage } from "@/components/api-error-card"
import { scanRecoveryHref } from "./scans-client.utils"
import type { ScanItem } from "./scan-types"

export function ScanList({
  scans,
  refreshing,
  nextCursor,
  loadingMore,
  targetFilter,
  stateFilter,
  hasTargets,
  onClearFilters,
  onShowCreate,
  cancelling,
  removing,
  onCancelScan,
  onRemoveScan,
  onLoadMore,
}: {
  scans: ScanItem[]
  refreshing: boolean
  nextCursor: string | null
  loadingMore: boolean
  targetFilter: string
  stateFilter: ScanStateFilter
  hasTargets: boolean
  onClearFilters: () => void
  onShowCreate: () => void
  cancelling: string | null
  removing: string | null
  onCancelScan: (scanId: string) => Promise<void>
  onRemoveScan: (scanId: string) => Promise<void>
  onLoadMore: () => Promise<void>
}) {
  return (
    <>
      {refreshing && scans.length === 0 ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label={`Loading ${RUN_PLURAL.toLowerCase()}`}
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-20 w-full" />
          ))}
        </div>
      ) : scans.length === 0 ? (
        <EmptyState
          icon={Radar}
          title={
            targetFilter || stateFilter !== "ALL"
              ? `No ${RUN_PLURAL.toLowerCase()} match these filters`
              : `No ${RUN_PLURAL.toLowerCase()} yet`
          }
          description={
            targetFilter || stateFilter !== "ALL"
              ? "Try a different target or state filter."
              : hasTargets
                ? `Start your first ${RUN_SINGULAR.toLowerCase()} with "New ${RUN_SINGULAR}".`
                : `Add a ${TARGET_SINGULAR.toLowerCase()} first, then you can run ${RUN_PLURAL.toLowerCase()} against it.`
          }
          action={
            targetFilter || stateFilter !== "ALL" ? (
              <Button
                variant="outline"
                onClick={() => {
                  onClearFilters()
                }}
              >
                Clear filters
              </Button>
            ) : hasTargets ? (
              <Button onClick={() => onShowCreate()}>
                <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                New {RUN_SINGULAR}
              </Button>
            ) : (
              <Link href="/dashboard/targets" className={buttonVariants()}>
                Add a {TARGET_SINGULAR.toLowerCase()}
              </Link>
            )
          }
        />
      ) : (
        <div className="space-y-2">
          {scans.map((scan) => {
            const presentation = getScanPresentation(scan.status, {
              errorCategory: scan.errorCategory,
              errorMessage: scan.errorMessage,
            })
            const active = isActiveScan(scan.status)
            const needsAttention = ["FAILED", "STOPPED_BUDGET", "TIMED_OUT"].includes(scan.status)
            return (
              <Card key={scan.id} className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={presentation.badgeVariant}>{presentation.label}</Badge>
                      <Link
                        href={`/dashboard/scans/${scan.id}`}
                        className="truncate text-sm font-medium hover:underline"
                      >
                        {scan.target?.name ?? "Workspace scan"}
                      </Link>
                      <span className="text-muted-foreground text-xs">
                        {modeLabel(scan.mode)} · {getGoalLabel(scan.goal)}
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span className="whitespace-nowrap">{formatDateTime(scan.createdAt)}</span>
                      {scan.endedAt && (
                        <span className="whitespace-nowrap">
                          · completed {formatDateTime(scan.endedAt)}
                        </span>
                      )}
                      {scan.findingCount !== undefined && scan.findingCount > 0 && (
                        <span className="text-foreground font-medium whitespace-nowrap">
                          {scan.findingCount} finding{scan.findingCount !== 1 ? "s" : ""} from this
                          scan
                        </span>
                      )}
                    </div>
                    {scan.errorMessage && presentation.showFailureDetails && (
                      <p className="text-destructive line-clamp-1 text-xs wrap-break-word">
                        {safeApiErrorMessage(scan.errorMessage)}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {active &&
                      (cancelling === scan.id ? (
                        <Button variant="outline" size="sm" disabled>
                          <Spinner className="h-4 w-4" />
                          <span className="ml-1">Cancelling…</span>
                        </Button>
                      ) : (
                        <InlineConfirm
                          triggerLabel="Cancel"
                          triggerIcon={<X className="mr-1 h-4 w-4" aria-hidden="true" />}
                          triggerVariant="outline"
                          confirmLabel="Stop scan"
                          message="Stop this scan?"
                          aria-label="Cancel this scan"
                          onConfirm={() => onCancelScan(scan.id)}
                        />
                      ))}
                    {!active && needsAttention && scan.target && (
                      <Link
                        href={scanRecoveryHref({
                          targetId: scan.target.id,
                          goal: scan.goal,
                          mode: scan.mode,
                        })}
                        aria-label={`Retry setup for ${scan.target?.name ?? "scan"}`}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        <RotateCcw className="mr-1 h-4 w-4" aria-hidden="true" />
                        Retry
                      </Link>
                    )}
                    {!active &&
                      !needsAttention &&
                      (removing === scan.id ? (
                        <Button variant="ghost" size="sm" disabled aria-label="Removing scan">
                          <Spinner className="h-4 w-4" />
                        </Button>
                      ) : (
                        <InlineConfirm
                          triggerIcon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                          aria-label="Remove scan"
                          message="Remove this scan from the workspace?"
                          confirmLabel="Remove"
                          onConfirm={() => onRemoveScan(scan.id)}
                        />
                      ))}
                    <Link
                      href={`/dashboard/scans/${scan.id}`}
                      aria-label={`Open details for ${scan.target?.name ?? "scan"}`}
                      className="text-muted-foreground hover:text-foreground inline-flex min-h-11 min-w-11 items-center justify-center"
                    >
                      <ChevronRight className="h-5 w-5" aria-hidden="true" />
                    </Link>
                  </div>
                </div>
              </Card>
            )
          })}

          {nextCursor && (
            <div className="flex justify-center pt-4">
              <Button variant="outline" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? <Spinner /> : "Load More"}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  )
}
