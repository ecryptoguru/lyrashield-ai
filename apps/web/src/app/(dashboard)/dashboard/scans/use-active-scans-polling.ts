import { useEffect, type Dispatch, type SetStateAction } from "react"
import { apiGetPaginated, apiGetPaginatedConditional } from "@/lib/api-client"
import { scansPaginatedSchema } from "@/lib/api-schemas"
import type { ScanStateFilter } from "@/lib/scan-presentation"
import {
  mergePolledScans,
  mergeResolvedOffPageScans,
  missingActiveScanIds,
} from "./scans-client.utils"
import type { ScanItem } from "./scan-types"

export function useActiveScansPolling({
  hasActiveScans,
  workspaceId,
  listParams,
  stateFilter,
  targetFilter,
  scansRef,
  firstPageIdsRef,
  firstPageHasMoreRef,
  setScans,
  setPollStale,
}: {
  hasActiveScans: boolean
  workspaceId: string
  listParams: (extra?: Record<string, string>) => Record<string, string>
  stateFilter: ScanStateFilter
  targetFilter: string
  scansRef: { current: ScanItem[] }
  firstPageIdsRef: { current: Set<string> }
  firstPageHasMoreRef: { current: boolean }
  setScans: Dispatch<SetStateAction<ScanItem[]>>
  setPollStale: Dispatch<SetStateAction<boolean>>
}) {
  useEffect(() => {
    if (!hasActiveScans) return
    // SSR safety: the polling loop touches `document`; never assume a DOM.
    if (typeof document === "undefined") return
    const controller = new AbortController()
    let timeoutId: number | undefined
    let isAborted = false
    let pollEtag: string | undefined
    const pollStartedAt = Date.now()

    const INITIAL_POLL_DELAY_MS = 10_000
    const VISIBILITY_POLL_DELAY_MS = 0
    const POLL_FAST_INTERVAL_MS = 10_000
    const POLL_MEDIUM_INTERVAL_MS = 30_000
    const POLL_SLOW_INTERVAL_MS = 60_000
    const POLL_MEDIUM_THRESHOLD_MS = 5 * 60_000
    const POLL_SLOW_THRESHOLD_MS = 60_000

    const nextInterval = (elapsedMs: number): number => {
      if (elapsedMs < POLL_SLOW_THRESHOLD_MS) return POLL_FAST_INTERVAL_MS
      if (elapsedMs < POLL_MEDIUM_THRESHOLD_MS) return POLL_MEDIUM_INTERVAL_MS
      return POLL_SLOW_INTERVAL_MS
    }

    // Battery/network: while the tab is hidden the poll loop suspends entirely
    // — no timer spin and no requests. `onVisibility` below resumes it with one
    // immediate refetch when the tab becomes visible, so the list catches up
    // right away instead of waiting out the (up to 60s) backoff interval.
    const poll = async () => {
      if (document.hidden) return
      try {
        // Poll the bounded first page so a scan's terminal state replaces its
        // previous active row. The ETag from the previous tick makes an
        // unchanged list a bodyless 304.
        const { data, etag } = await apiGetPaginatedConditional("/api/scans", listParams(), {
          signal: controller.signal,
          schema: scansPaginatedSchema,
          ...(pollEtag ? { etag: pollEtag } : {}),
        })
        if (etag) pollEtag = etag
        if (data) {
          firstPageIdsRef.current = new Set(data.items.map((scan) => scan.id))
          firstPageHasMoreRef.current = data.nextCursor !== null
        }

        const unfiltered = stateFilter === "ALL" && !targetFilter
        const missingIds = unfiltered
          ? missingActiveScanIds(
              scansRef.current,
              firstPageIdsRef.current,
              firstPageHasMoreRef.current
            )
          : []
        const resolvedMissing = missingIds.length
          ? await apiGetPaginated<ScanItem>(
              "/api/scans",
              { workspaceId, ids: missingIds.join(",") },
              { signal: controller.signal, schema: scansPaginatedSchema }
            )
          : null

        setPollStale(false)
        if (!controller.signal.aborted && (data || resolvedMissing)) {
          setScans((current) => {
            if (!unfiltered) {
              // A filtered view replaces its page wholesale: rows that no
              // longer match the filter must not linger from a previous page.
              return data ? data.items : current
            }
            let merged = data
              ? mergePolledScans(current, data.items, { hasMore: data.nextCursor !== null })
              : current
            if (!resolvedMissing) return merged
            return mergeResolvedOffPageScans(merged, resolvedMissing.items, missingIds)
          })
        }
      } catch {
        if (!controller.signal.aborted) setPollStale(true)
      }
      if (isAborted) return
      const elapsed = Date.now() - pollStartedAt
      const nextPollDelay = nextInterval(elapsed)
      timeoutId = window.setTimeout(poll, nextPollDelay)
    }

    timeoutId = window.setTimeout(poll, INITIAL_POLL_DELAY_MS)

    const onVisibility = () => {
      if (!document.hidden && hasActiveScans && !isAborted) {
        window.clearTimeout(timeoutId)
        timeoutId = window.setTimeout(poll, VISIBILITY_POLL_DELAY_MS)
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      isAborted = true
      controller.abort()
      document.removeEventListener("visibilitychange", onVisibility)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [
    hasActiveScans,
    workspaceId,
    listParams,
    stateFilter,
    targetFilter,
    scansRef,
    firstPageIdsRef,
    firstPageHasMoreRef,
    setScans,
    setPollStale,
  ])
}
