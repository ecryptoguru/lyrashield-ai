"use client"

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"
import { apiDelete, apiPost, apiGetPaginated } from "@/lib/api-client"
import { scanCancelSchema, scansPaginatedSchema } from "@/lib/api-schemas"
import {
  isActiveScan,
  parseScanStateFilter,
  scanStateStatuses,
  type ScanStateFilter,
} from "@/lib/scan-presentation"
import type { ScanItem } from "./scan-types"
import { useActiveScansPolling } from "./use-active-scans-polling"
import { mergePolledScans, mergeResolvedOffPageScans } from "./scans-client.utils"

type ScanPage = { items: ScanItem[]; nextCursor: string | null }
function uniqueScans(items: ScanItem[]) {
  const seen = new Set<string>()
  return items.filter((scan) => !seen.has(scan.id) && seen.add(scan.id))
}

interface ScanListStateOptions {
  workspaceId: string
  initialData: ScanItem[]
  initialNextCursor: string | null
  initialTargetFilter: string
  initialStateFilter: ScanStateFilter
  setError: Dispatch<SetStateAction<string | null>>
  setErrorCode: Dispatch<SetStateAction<string | null>>
}

export function useScanListState({
  workspaceId,
  initialData,
  initialNextCursor,
  initialTargetFilter,
  initialStateFilter,
  setError,
  setErrorCode,
}: ScanListStateOptions) {
  const [page, setPage] = useState({ scans: initialData, nextCursor: initialNextCursor })
  const { scans, nextCursor } = page
  const [pagesReset, setPagesReset] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [pollStale, setPollStale] = useState(false)
  // Server-parsed URL filters; updated via replaceState and refetch.
  const [targetFilter, setTargetFilter] = useState(initialTargetFilter)
  const [stateFilter, setStateFilter] = useState<ScanStateFilter>(initialStateFilter)
  const scansRef = useRef(scans)
  const firstPageIdsRef = useRef(new Set(initialData.map((scan) => scan.id)))
  const firstPageHasMoreRef = useRef(initialNextCursor !== null)
  const listRequestRef = useRef(0)
  const firstPagePendingRef = useRef<number | null>(null)
  const loadMoreRequestRef = useRef(0)
  const loadedPagesRef = useRef(false)
  const pollEtagRef = useRef<string | undefined>(undefined)
  const previousWorkspaceRef = useRef(workspaceId)
  const workspaceEpochRef = useRef(0)
  const stateFilterRef = useRef(stateFilter)

  const invalidateRequests = useCallback(() => {
    ++listRequestRef.current
    ++loadMoreRequestRef.current
    firstPagePendingRef.current = null
    pollEtagRef.current = undefined
    setLoadingMore(false)
  }, [])

  // Locally accepted creation/cancellation/removal must also supersede older reads.
  const setScans: Dispatch<SetStateAction<ScanItem[]>> = useCallback(
    (update) => {
      invalidateRequests()
      setPage((current) => ({
        ...current,
        scans: uniqueScans(typeof update === "function" ? update(current.scans) : update),
      }))
    },
    [invalidateRequests]
  )

  useEffect(() => {
    const workspaceEpoch = workspaceEpochRef
    if (previousWorkspaceRef.current !== workspaceId) {
      previousWorkspaceRef.current = workspaceId
      // Workspace props are a new server snapshot, not rows from the previous tenant.
      setPage({ scans: initialData, nextCursor: initialNextCursor })
      setTargetFilter(initialTargetFilter)
      setStateFilter(initialStateFilter)
      setPollStale(false)
      setPagesReset(false)
      setRefreshing(false)
      setCancelling(null)
      setRemoving(null)
      loadedPagesRef.current = false
      firstPageIdsRef.current = new Set(initialData.map((scan) => scan.id))
      firstPageHasMoreRef.current = initialNextCursor !== null
    }
    return () => {
      ++workspaceEpoch.current
      invalidateRequests()
    }
    // Only a workspace transition replaces the initial server snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, invalidateRequests])

  const isCurrentRequest = useCallback(
    (requestId: number) => requestId === listRequestRef.current,
    []
  )
  const beginPoll = useCallback(
    () => (firstPagePendingRef.current === null ? listRequestRef.current : null),
    []
  )
  const acceptPoll = useCallback(
    (
      requestId: number,
      data: ScanPage | null,
      resolved: ScanItem[] | null,
      missingIds: string[]
    ) => {
      if (!isCurrentRequest(requestId)) return false
      if (data || resolved) {
        ++listRequestRef.current
        ++loadMoreRequestRef.current
        setLoadingMore(false)
        const unfiltered = stateFilter === "ALL" && !targetFilter
        const hadLoadedPages = loadedPagesRef.current
        if (data) {
          firstPageIdsRef.current = new Set(data.items.map((scan) => scan.id))
          firstPageHasMoreRef.current = data.nextCursor !== null
        }
        if (data && !unfiltered) {
          loadedPagesRef.current = false
          setPagesReset(hadLoadedPages)
        }
        setPage((current) => {
          if (!unfiltered)
            return data ? { scans: uniqueScans(data.items), nextCursor: data.nextCursor } : current
          let merged = data
            ? mergePolledScans(current.scans, data.items, { hasMore: data.nextCursor !== null })
            : current.scans
          if (resolved) merged = mergeResolvedOffPageScans(merged, resolved, missingIds)
          return {
            scans: uniqueScans(merged),
            nextCursor:
              data && (!hadLoadedPages || data.nextCursor === null)
                ? data.nextCursor
                : current.nextCursor,
          }
        })
      }
      setPollStale(false)
      return true
    },
    [isCurrentRequest, stateFilter, targetFilter]
  )

  useEffect(() => {
    scansRef.current = scans
    stateFilterRef.current = stateFilter
  }, [scans, stateFilter])

  const listParams = useCallback(
    (extra: Record<string, string> = {}) => ({
      workspaceId,
      ...(targetFilter ? { targetId: targetFilter } : {}),
      ...(stateFilter !== "ALL" ? { state: stateFilter } : {}),
      ...extra,
    }),
    [workspaceId, targetFilter, stateFilter]
  )

  function updateFilterUrl(next: { target?: string; state?: ScanStateFilter }) {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const nextTarget = next.target ?? targetFilter
    const nextState = next.state ?? stateFilter
    if (nextTarget) params.set("target", nextTarget)
    else params.delete("target")
    if (nextState !== "ALL") params.set("state", nextState)
    else params.delete("state")
    const search = params.toString()
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}`
    )
  }

  async function refetchFirstPage(
    nextTarget = targetFilter,
    nextState: ScanStateFilter = stateFilter
  ) {
    const requestId = ++listRequestRef.current
    firstPagePendingRef.current = requestId
    setRefreshing(true)
    ++loadMoreRequestRef.current
    pollEtagRef.current = undefined
    setLoadingMore(false)
    try {
      const result = await apiGetPaginated<ScanItem>(
        "/api/scans",
        {
          workspaceId,
          ...(nextTarget ? { targetId: nextTarget } : {}),
          ...(nextState !== "ALL" ? { state: nextState } : {}),
        },
        { schema: scansPaginatedSchema }
      )
      if (requestId !== listRequestRef.current) return false
      setPage({ scans: uniqueScans(result.items), nextCursor: result.nextCursor })
      loadedPagesRef.current = false
      setPagesReset(false)
      setPollStale(false)
      firstPageIdsRef.current = new Set(result.items.map((scan) => scan.id))
      firstPageHasMoreRef.current = result.nextCursor !== null
      return true
    } catch (error) {
      if (requestId !== listRequestRef.current) return false
      throw error
    } finally {
      if (requestId === firstPagePendingRef.current) {
        firstPagePendingRef.current = null
        setRefreshing(false)
      }
    }
  }

  function handleTargetFilterChange(value: string) {
    setTargetFilter(value)
    setPage({ scans: [], nextCursor: null })
    updateFilterUrl({ target: value })
    setError(null)
    setErrorCode(null)
    refetchFirstPage(value, stateFilter).catch(() => setPollStale(true))
  }

  function handleStateFilterChange(value: string) {
    const next = parseScanStateFilter(value)
    setStateFilter(next)
    setPage({ scans: [], nextCursor: null })
    updateFilterUrl({ state: next })
    setError(null)
    setErrorCode(null)
    refetchFirstPage(targetFilter, next).catch(() => setPollStale(true))
  }

  function handleClearFilters() {
    setTargetFilter("")
    setStateFilter("ALL")
    setPage({ scans: [], nextCursor: null })
    updateFilterUrl({ target: "", state: "ALL" })
    setError(null)
    setErrorCode(null)
    refetchFirstPage("", "ALL").catch(() => setPollStale(true))
  }

  async function handleCancelScan(scanId: string) {
    const workspaceEpoch = workspaceEpochRef.current
    setCancelling(scanId)
    setError(null)
    setErrorCode(null)
    try {
      const result = await apiPost(
        `/api/scans/${scanId}`,
        { workspaceId },
        { schema: scanCancelSchema }
      )
      if (workspaceEpoch !== workspaceEpochRef.current) return
      const statuses = scanStateStatuses(stateFilterRef.current)
      setScans((prev) =>
        prev
          .map((s) =>
            s.id === scanId ? { ...s, status: result.status, endedAt: result.endedAt } : s
          )
          .filter((scan) => !statuses || statuses.includes(scan.status))
      )
    } catch (err) {
      if (workspaceEpoch === workspaceEpochRef.current)
        setError(err instanceof Error ? err.message : "Failed to cancel scan")
    } finally {
      if (workspaceEpoch === workspaceEpochRef.current) setCancelling(null)
    }
  }

  async function handleRemoveScan(scanId: string) {
    const workspaceEpoch = workspaceEpochRef.current
    setRemoving(scanId)
    setError(null)
    setErrorCode(null)
    try {
      await apiDelete(`/api/scans/${scanId}?workspaceId=${encodeURIComponent(workspaceId)}`)
      if (workspaceEpoch !== workspaceEpochRef.current) return
      setScans((prev) => prev.filter((scan) => scan.id !== scanId))
    } catch (err) {
      if (workspaceEpoch === workspaceEpochRef.current)
        setError(err instanceof Error ? err.message : "Failed to remove scan")
    } finally {
      if (workspaceEpoch === workspaceEpochRef.current) setRemoving(null)
    }
  }

  async function handleLoadMore() {
    if (!nextCursor || firstPagePendingRef.current !== null || loadingMore) return
    const requestId = listRequestRef.current
    const loadMoreRequestId = ++loadMoreRequestRef.current
    setLoadingMore(true)
    setErrorCode(null)
    try {
      const result = await apiGetPaginated<ScanItem>(
        "/api/scans",
        listParams({ cursor: nextCursor }),
        { schema: scansPaginatedSchema }
      )
      if (requestId !== listRequestRef.current || loadMoreRequestId !== loadMoreRequestRef.current)
        return
      loadedPagesRef.current = true
      setPagesReset(false)
      setPage((current) => ({
        scans: uniqueScans([...current.scans, ...result.items]),
        nextCursor: result.nextCursor,
      }))
    } catch {
      if (requestId === listRequestRef.current && loadMoreRequestId === loadMoreRequestRef.current)
        setError("Failed to load more scans")
    } finally {
      if (requestId === listRequestRef.current && loadMoreRequestId === loadMoreRequestRef.current)
        setLoadingMore(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    setError(null)
    setErrorCode(null)
    const refresh = refetchFirstPage()
    const requestId = listRequestRef.current
    try {
      if (await refresh) setPollStale(false)
    } catch {
      setPollStale(true)
    } finally {
      if (isCurrentRequest(requestId)) setRefreshing(false)
    }
  }

  const hasActiveScans = scans.some((scan) => isActiveScan(scan.status))
  useActiveScansPolling({
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
  })

  return {
    scans,
    setScans,
    nextCursor,
    loadingMore,
    refreshing,
    pollStale,
    pagesReset,
    targetFilter,
    stateFilter,
    cancelling,
    removing,
    handleTargetFilterChange,
    handleStateFilterChange,
    handleClearFilters,
    handleCancelScan,
    handleRemoveScan,
    handleLoadMore,
    handleRefresh,
  }
}
