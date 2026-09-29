import { useEffect, type Dispatch, type SetStateAction } from "react"
import { apiGetPaginated, apiGetPaginatedConditional } from "@/lib/api-client"
import { scansPaginatedSchema } from "@/lib/api-schemas"
import type { ScanStateFilter } from "@/lib/scan-presentation"
import { missingActiveScanIds, nextActiveScanPollInterval } from "./scans-client.utils"
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
  beginPoll,
  isCurrentRequest,
  acceptPoll,
  pollEtagRef,
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
  beginPoll: () => number | null
  isCurrentRequest: (requestId: number) => boolean
  acceptPoll: (
    requestId: number,
    data: { items: ScanItem[]; nextCursor: string | null } | null,
    resolved: ScanItem[] | null,
    missingIds: string[]
  ) => boolean
  pollEtagRef: { current: string | undefined }
  setPollStale: Dispatch<SetStateAction<boolean>>
}) {
  useEffect(() => {
    if (!hasActiveScans) return
    // SSR safety: the polling loop touches `document`; never assume a DOM.
    if (typeof document === "undefined") return
    const controller = new AbortController()
    let timeoutId: number | undefined
    let isAborted = false
    let inFlight = false
    let refreshOnVisible = false
    const pollStartedAt = Date.now()

    const INITIAL_POLL_DELAY_MS = 10_000
    const VISIBILITY_POLL_DELAY_MS = 0

    const schedule = (delayMs: number) => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      timeoutId = undefined
      if (!isAborted && !document.hidden) timeoutId = window.setTimeout(poll, delayMs)
    }

    // Battery/network: while the tab is hidden the poll loop suspends entirely
    // — no timer spin and no requests. `onVisibility` below resumes it with one
    // immediate refetch when the tab becomes visible, so the list catches up
    // right away instead of waiting out the (up to 60s) backoff interval.
    const poll = async () => {
      timeoutId = undefined
      if (isAborted || document.hidden || inFlight) return
      const requestId = beginPoll()
      if (requestId === null) {
        schedule(nextActiveScanPollInterval(Date.now() - pollStartedAt))
        return
      }
      inFlight = true
      try {
        // Poll the bounded first page so a scan's terminal state replaces its
        // previous active row. The ETag from the previous tick makes an
        // unchanged list a bodyless 304.
        const { data, etag } = await apiGetPaginatedConditional("/api/scans", listParams(), {
          signal: controller.signal,
          schema: scansPaginatedSchema,
          ...(pollEtagRef.current ? { etag: pollEtagRef.current } : {}),
        })
        if (controller.signal.aborted || !isCurrentRequest(requestId)) return
        const unfiltered = stateFilter === "ALL" && !targetFilter
        const missingIds = unfiltered
          ? missingActiveScanIds(
              scansRef.current,
              data ? new Set(data.items.map((scan) => scan.id)) : firstPageIdsRef.current,
              data ? data.nextCursor !== null : firstPageHasMoreRef.current
            )
          : []
        const resolvedMissing = missingIds.length
          ? await apiGetPaginated<ScanItem>(
              "/api/scans",
              { workspaceId, ids: missingIds.join(",") },
              { signal: controller.signal, schema: scansPaginatedSchema }
            )
          : null

        if (controller.signal.aborted) return
        if (acceptPoll(requestId, data, resolvedMissing?.items ?? null, missingIds)) {
          pollEtagRef.current = data ? etag : (etag ?? pollEtagRef.current)
        }
      } catch {
        if (!controller.signal.aborted && isCurrentRequest(requestId)) setPollStale(true)
      } finally {
        inFlight = false
        if (!isAborted && !document.hidden) {
          const delay = refreshOnVisible
            ? 0
            : nextActiveScanPollInterval(Date.now() - pollStartedAt)
          refreshOnVisible = false
          schedule(delay)
        }
      }
    }

    schedule(INITIAL_POLL_DELAY_MS)

    const onVisibility = () => {
      if (document.hidden) {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
        timeoutId = undefined
        refreshOnVisible = false
      } else if (hasActiveScans && !isAborted) {
        if (inFlight) refreshOnVisible = true
        else schedule(VISIBILITY_POLL_DELAY_MS)
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
    beginPoll,
    isCurrentRequest,
    acceptPoll,
    pollEtagRef,
    setPollStale,
  ])
}
