"use client"

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"
import { apiDelete, apiPost, apiGetPaginated } from "@/lib/api-client"
import { scanCancelSchema, scansPaginatedSchema } from "@/lib/api-schemas"
import { isActiveScan, parseScanStateFilter, type ScanStateFilter } from "@/lib/scan-presentation"
import type { ScanItem } from "./scan-types"
import { useActiveScansPolling } from "./use-active-scans-polling"

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
  const [scans, setScans] = useState<ScanItem[]>(initialData)
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor)
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

  useEffect(() => {
    scansRef.current = scans
  }, [scans])

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
    const result = await apiGetPaginated<ScanItem>(
      "/api/scans",
      {
        workspaceId,
        ...(nextTarget ? { targetId: nextTarget } : {}),
        ...(nextState !== "ALL" ? { state: nextState } : {}),
      },
      {
        schema: scansPaginatedSchema,
      }
    )
    setScans(result.items)
    setNextCursor(result.nextCursor)
    firstPageIdsRef.current = new Set(result.items.map((scan) => scan.id))
    firstPageHasMoreRef.current = result.nextCursor !== null
  }

  function handleTargetFilterChange(value: string) {
    setTargetFilter(value)
    updateFilterUrl({ target: value })
    setError(null)
    setErrorCode(null)
    refetchFirstPage(value, stateFilter).catch(() => setPollStale(true))
  }

  function handleStateFilterChange(value: string) {
    const next = parseScanStateFilter(value)
    setStateFilter(next)
    updateFilterUrl({ state: next })
    setError(null)
    setErrorCode(null)
    refetchFirstPage(targetFilter, next).catch(() => setPollStale(true))
  }

  function handleClearFilters() {
    setTargetFilter("")
    setStateFilter("ALL")
    updateFilterUrl({ target: "", state: "ALL" })
    setError(null)
    setErrorCode(null)
    refetchFirstPage("", "ALL").catch(() => setPollStale(true))
  }

  async function handleCancelScan(scanId: string) {
    setCancelling(scanId)
    setError(null)
    setErrorCode(null)
    try {
      const result = await apiPost(
        `/api/scans/${scanId}`,
        { workspaceId },
        { schema: scanCancelSchema }
      )
      setScans((prev) =>
        prev.map((s) =>
          s.id === scanId ? { ...s, status: result.status, endedAt: result.endedAt } : s
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel scan")
    } finally {
      setCancelling(null)
    }
  }

  async function handleRemoveScan(scanId: string) {
    setRemoving(scanId)
    setError(null)
    setErrorCode(null)
    try {
      await apiDelete(`/api/scans/${scanId}?workspaceId=${encodeURIComponent(workspaceId)}`)
      setScans((prev) => prev.filter((scan) => scan.id !== scanId))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove scan")
    } finally {
      setRemoving(null)
    }
  }

  async function handleLoadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    setErrorCode(null)
    try {
      const result = await apiGetPaginated<ScanItem>(
        "/api/scans",
        listParams({ cursor: nextCursor }),
        { schema: scansPaginatedSchema }
      )
      setScans((prev) => [...prev, ...result.items])
      setNextCursor(result.nextCursor)
    } catch {
      setError("Failed to load more scans")
    } finally {
      setLoadingMore(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    setError(null)
    setErrorCode(null)
    try {
      await refetchFirstPage()
      setPollStale(false)
    } catch {
      setPollStale(true)
    } finally {
      setRefreshing(false)
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
    setScans,
    setPollStale,
  })

  return {
    scans,
    setScans,
    nextCursor,
    loadingMore,
    refreshing,
    pollStale,
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
