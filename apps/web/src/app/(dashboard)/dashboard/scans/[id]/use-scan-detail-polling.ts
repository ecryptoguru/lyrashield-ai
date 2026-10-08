"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import { ScanQualitySurfaceSchema } from "@lyrashield/types"
import { findingDetailItemsPaginatedSchema, scanPollDataSchema } from "@/lib/api-schemas"
import { apiGet, apiGetConditional, apiGetPaginated } from "@/lib/api-client"
import { isActiveScan } from "@/lib/scan-presentation"
import type { FindingItem, ScanData, ScanPollData } from "./scan-detail-types"
import { asIsoString, asMetadata, mergeEvents } from "./scan-detail-utils"
import { useScanPollLoop } from "./scan-poll-loop"

// Re-exported so importers keep a single entry point; the arithmetic itself
// lives in a React-free module so it can be tested against a stable clock.
export { nextScanDetailPollInterval, scanDetailPollDelay } from "./scan-detail-poll-schedule"

/** Keep a new validator uncommitted until its poll response has been fully applied. */
export function selectScanPollEtag({
  currentEtag,
  responseEtag,
  responseStatus,
  responseProcessed,
}: {
  currentEtag: string | undefined
  responseEtag: string | undefined
  responseStatus: number
  responseProcessed: boolean
}): string | undefined {
  if (responseStatus === 304) return responseEtag ?? currentEtag
  if (!responseProcessed) return currentEtag
  return responseEtag
}

type PollResponse = { etag: string | undefined; status: number; processed: boolean }

function commitPollEtag(ref: { current: string | undefined }, response: PollResponse): void {
  ref.current = selectScanPollEtag({
    currentEtag: ref.current,
    responseEtag: response.etag,
    responseStatus: response.status,
    responseProcessed: response.processed,
  })
}

const TERMINAL_SCAN_STATUSES = new Set([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
  "STOPPED_BUDGET",
  "TIMED_OUT",
])

async function fetchTerminalDetails(
  scanId: string,
  workspaceId: string,
  signal: AbortSignal
): Promise<{ findings: FindingItem[]; quality: ScanData["integrity"]["quality"] }> {
  const page = await apiGetPaginated<FindingItem>(
    "/api/findings",
    { workspaceId, scanId, limit: "100" },
    { signal, schema: findingDetailItemsPaginatedSchema }
  )
  let quality: ScanData["integrity"]["quality"] = null
  try {
    quality = await apiGet(
      `/api/scans/${scanId}/quality?workspaceId=${encodeURIComponent(workspaceId)}`,
      { signal, schema: ScanQualitySurfaceSchema }
    )
  } catch {
    // Keep the terminal outcome visible; omit a stale quality snapshot.
  }
  return { findings: page.items, quality }
}

/**
 * Owns the live-state machinery of the scan detail page: the polled scan and
 * finding state, the ETag/event-cursor refs, the visibility-aware poll loop,
 * and the manual full-window refresh. The view stays a pure function of the
 * state this hook returns.
 */
export function useScanDetailPolling(initialScan: ScanData, initialFindings: FindingItem[]) {
  const router = useRouter()
  const [scan, setScan] = useState<ScanData>(initialScan)
  const [currentFindings, setCurrentFindings] = useState<FindingItem[]>(initialFindings)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState(false)
  const isActive = isActiveScan(scan.status)
  const etagRef = useRef<string | undefined>(undefined)
  const activeRequestRef = useRef<{ controller: AbortController; promise: Promise<void> } | null>(
    null
  )
  const scanRef = useRef(scan)
  useEffect(() => {
    scanRef.current = scan
  }, [scan])

  // Incremental event polling cursor: the id of the newest event already held
  // client-side. Each poll sends `eventsAfter` so the server returns only the
  // tail. A ref (not state) so the in-flight poll callback always reads the
  // latest cursor without re-render churn; it only advances after a successful
  // merge, so a failed or aborted poll re-delivers the same tail next tick.
  const eventCursorRef = useRef<string | null>(initialScan.events.at(-1)?.id ?? null)

  // A successful commit re-derives the cursor from the merged list (single
  // source of truth), so a failed, aborted, or validation-rejected poll never
  // advances it and the next tick re-delivers the same tail.
  useEffect(() => {
    eventCursorRef.current = scan.events.at(-1)?.id ?? null
  }, [scan])

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      let pollResponse: PollResponse | undefined
      try {
        // Incremental polling: once a cursor exists, ask only for events after
        // it. The first tick (or a full-window fallback) repopulates the whole
        // list; manual refresh clears the cursor below to force that path.
        const eventCursor = eventCursorRef.current
        const cursorParam = eventCursor ? `&eventsAfter=${encodeURIComponent(eventCursor)}` : ""
        const { data, etag, status } = await apiGetConditional<ScanPollData>(
          `/api/scans/${scan.id}?workspaceId=${encodeURIComponent(scan.workspaceId)}${cursorParam}`,
          { signal, etag: etagRef.current, schema: scanPollDataSchema }
        )
        if (signal.aborted) return
        pollResponse = { etag, status, processed: false }
        setRefreshError(false)
        if (!data) {
          pollResponse.processed = true
          commitPollEtag(etagRef, pollResponse)
          return
        }

        const updated = data
        const nextScan: ScanData = {
          id: updated.id,
          workspaceId: updated.workspaceId,
          status: updated.status,
          goal: updated.goal,
          mode: updated.mode,
          triggerType: updated.triggerType,
          target: scanRef.current.target,
          startedAt: asIsoString(updated.startedAt),
          endedAt: asIsoString(updated.endedAt),
          summary: updated.summary,
          errorCategory: updated.errorCategory,
          errorMessage: updated.errorMessage,
          createdAt: asIsoString(updated.createdAt)!,
          // The immutable plan is SSR-only; the poll never carries it.
          executionPlan: scanRef.current.executionPlan,
          events: mergeEvents(
            scanRef.current.events,
            (updated.events ?? []).map((event) => ({
              id: event.id,
              stage: event.stage,
              level: event.level,
              message: event.message,
              metadata: asMetadata(event.metadata),
              createdAt: asIsoString(event.createdAt)!,
            })),
            // A tail page is only merged when the server echoes that the
            // cursor sent on this very request was applied; anything else is a
            // full replacement.
            updated.eventsCursorApplied === eventCursor && eventCursor !== null
          ),
          integrity: {
            ...scanRef.current.integrity,
            manifestChecksum: updated.resultManifest?.checksum ?? null,
            // urlExecution comes from the server-rendered manifest detail;
            // the polling payload carries the checksum only.
            urlExecution: scanRef.current.integrity.urlExecution,
            coverage: (updated.coverageReceipts ?? []).map((receipt) => ({
              scanner: receipt.scanner,
              controlId: receipt.controlId,
              status: receipt.status,
              reason: receipt.reason ?? null,
              subject: receipt.subject ?? null,
              metadata: asMetadata(receipt.metadata),
            })),
          },
          aiSecurity: scanRef.current.aiSecurity,
        }
        let refreshedFindings: FindingItem[] | null = null
        let refreshedQuality: ScanData["integrity"]["quality"] = null
        if (TERMINAL_SCAN_STATUSES.has(updated.status)) {
          const details = await fetchTerminalDetails(scan.id, updated.workspaceId, signal)
          refreshedFindings = details.findings
          refreshedQuality = details.quality
          nextScan.integrity.quality = refreshedQuality
        }
        pollResponse.processed = true
        if (!signal.aborted) {
          commitPollEtag(etagRef, pollResponse)
          // Commit the terminal status and its finding list together. If the
          // finding request fails transiently, the active poll remains alive
          // and retries instead of rendering a false zero until page reload.
          setScan(nextScan)
          if (refreshedFindings) setCurrentFindings(refreshedFindings)
          if (updated.status === "COMPLETED" && refreshedFindings?.length === 0) {
            router.refresh()
          }
        }
      } catch {
        if (!signal.aborted) {
          if (pollResponse) {
            commitPollEtag(etagRef, pollResponse)
          }
          setRefreshError(true)
        }
      }
    },
    [router, scan.id, scan.workspaceId]
  )

  const runRefresh = useCallback(
    (manual = false) => {
      if (manual) activeRequestRef.current?.controller.abort()
      else if (activeRequestRef.current) return activeRequestRef.current.promise

      const controller = new AbortController()
      const promise = refresh(controller.signal).finally(() => {
        if (activeRequestRef.current?.controller === controller) activeRequestRef.current = null
      })
      activeRequestRef.current = { controller, promise }
      return promise
    },
    [refresh]
  )

  const abortActiveRequest = useCallback(() => activeRequestRef.current?.controller.abort(), [])

  // The poll loop itself lives in ./scan-poll-loop; the visibility handling and
  // backoff intervals are unchanged, only their home is.
  useScanPollLoop({
    isActive,
    startedAt: scan.startedAt,
    runRefresh,
    abortActiveRequest,
  })

  useEffect(() => () => activeRequestRef.current?.controller.abort(), [])

  async function handleManualRefresh() {
    setRefreshing(true)
    etagRef.current = undefined
    // Force a full-window refetch: manual refresh is the user's "prove it"
    // action, so re-fetch every event instead of trusting the incremental tail.
    eventCursorRef.current = null
    try {
      await runRefresh(true)
    } finally {
      setRefreshing(false)
    }
  }

  /**
   * Apply the authoritative result of a cancellation. Only the status and end
   * time the server returned are written; nothing is inferred from the click.
   * Any poll already in flight is aborted first, so a response that was issued
   * before the cancel cannot write the previous status back over it. The poll
   * loop sees a terminal status and stops on its own.
   */
  function applyCancelledScan(status: string, endedAt: string | null) {
    activeRequestRef.current?.controller.abort()
    setScan((current) => ({ ...current, status, endedAt }))
  }

  return {
    scan,
    currentFindings,
    isActive,
    refreshing,
    refreshError,
    handleManualRefresh,
    applyCancelledScan,
  }
}
