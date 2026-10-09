"use client"

import { useEffect, useState } from "react"
import { getScanPresentation, isActiveScan } from "@/lib/scan-presentation"
import { apiPost, ApiError } from "@/lib/api-client"
import { scanCancelSchema } from "@/lib/api-schemas"
import { ScanInProgress } from "./scan-in-progress"
import {
  ScanDetailHeader,
  ScanEvidenceSummary,
  ScanRefreshPausedBanner,
  ScanTechnicalDetails,
  ScanTerminalView,
} from "./scan-detail-sections"
import { useScanDetailWebMcp } from "./scan-detail-webmcp"
import { useScanDetailPolling } from "./use-scan-detail-polling"
import { track } from "@/lib/analytics"
import { deriveScanDetailView } from "./scan-detail-presentation"
import type { CleanResultScorecard, FindingItem, ScanData } from "./scan-detail-types"
import { useCompletionNotice, useElapsedTime } from "./scan-detail-utils"

export function ScanDetailClient({
  scan: initialScan,
  findings,
  scorecard,
  canCancel = false,
}: {
  scan: ScanData
  findings: FindingItem[]
  scorecard: CleanResultScorecard | null
  /**
   * Whether the signed-in member holds scan:cancel in this workspace. The API
   * re-checks permission and the scan's state, and its authoritative result is
   * what this page renders after a cancellation.
   */
  canCancel?: boolean
}) {
  const {
    scan,
    currentFindings,
    isActive,
    refreshing,
    refreshError,
    handleManualRefresh,
    applyCancelledScan,
  } = useScanDetailPolling(initialScan, findings)
  const elapsedTime = useElapsedTime(isActive ? scan.startedAt : null)
  const presentation = getScanPresentation(scan.status, {
    errorCategory: scan.errorCategory,
    errorMessage: scan.errorMessage,
  })
  const [completionNotice, dismissCompletionNotice] = useCompletionNotice(initialScan.status, scan)
  const [expandedFindings, setExpandedFindings] = useState<Set<string>>(new Set())
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  /**
   * Cancel through the same endpoint the scan list uses. Only a successful
   * response changes the rendered status, and the status rendered is the one
   * the server returned — never an optimistic guess. A failure says the scan
   * may still be running instead of claiming it stopped.
   */
  async function handleCancelScan() {
    setCancelling(true)
    setCancelError(null)
    try {
      const result = await apiPost(
        `/api/scans/${scan.id}`,
        { workspaceId: scan.workspaceId },
        { schema: scanCancelSchema }
      )
      applyCancelledScan(result.status, result.endedAt)
    } catch (cause) {
      setCancelError(
        cause instanceof ApiError && cause.status < 500
          ? cause.message
          : "The scan could not be cancelled. It may still be running; refresh before trying again."
      )
    } finally {
      setCancelling(false)
    }
  }

  // Page-scoped agent read: `review_scan_progress` can only ever resolve the
  // scan this page displays; workspace/scan identity is bound at registration.
  useScanDetailWebMcp({ workspaceId: scan.workspaceId, scanId: scan.id })

  // Results landing: opening an already-terminal scan is a results view.
  // Status only — no finding detail, severity, or target coordinates.
  useEffect(() => {
    if (isActiveScan(initialScan.status)) return
    track("results_viewed", {
      status: initialScan.status,
      had_findings: findings.length > 0,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const view = deriveScanDetailView({ scan, currentFindings, presentation, isActive })

  function toggleFinding(id: string) {
    setExpandedFindings((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div>
      {/* Sole announcer for the scan-completion message. Always mounted, because
          a live region inserted at the same moment as its content is announced
          unreliably. The visible banner below is therefore presentational only —
          giving it live semantics too would double-announce. */}
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {completionNotice?.message}
      </div>
      <ScanDetailHeader
        scan={scan}
        presentation={presentation}
        isActive={isActive}
        refreshError={refreshError}
        canCancel={canCancel}
        cancelling={cancelling}
        cancelError={cancelError}
        onCancel={() => void handleCancelScan()}
      />

      <ScanEvidenceSummary
        scan={scan}
        isActive={isActive}
        nextAction={view.nextAction}
        displayedCoverageState={view.displayedCoverageState}
        coverageSummary={view.coverageSummary}
        coverageWarningCount={view.coverageWarnings.length}
        refreshing={refreshing}
        onRefresh={() => void handleManualRefresh()}
      />

      {refreshError && (
        <ScanRefreshPausedBanner
          refreshing={refreshing}
          onRetry={() => void handleManualRefresh()}
        />
      )}

      {/* In-progress view: replaces the stat-heavy completed layout while the scan is active */}
      {isActive && (
        <div className="mb-6">
          <ScanInProgress
            status={scan.status}
            mode={scan.mode}
            startedAt={scan.startedAt}
            elapsedTime={elapsedTime}
            events={view.displayEvents}
            findingsCount={currentFindings.length}
            queuePosition={scan.queuePosition ?? null}
            onRefresh={() => void handleManualRefresh()}
            refreshing={refreshing}
          />
        </div>
      )}

      {/* Completed / terminal layout — rendered only once the scan is no longer active */}
      {!isActive && (
        <ScanTerminalView
          scan={scan}
          presentation={presentation}
          view={view}
          scorecard={scorecard}
          completionNotice={completionNotice}
          onDismissNotice={dismissCompletionNotice}
          expandedFindings={expandedFindings}
          onToggleFinding={toggleFinding}
        />
      )}

      <ScanTechnicalDetails displayEvents={view.displayEvents} />
    </div>
  )
}
