"use client"
import { useState, useEffect, useCallback, useRef } from "react"
import { useFindingsWebMcp } from "./findings-webmcp"
import { FindingDetailDrawer } from "./finding-detail-drawer"
import { FindingsControls, FindingsResults } from "./findings-client-view"
import { useFindingDrawer } from "./use-finding-drawer"
import { type FindingsListPage } from "./findings-list-context"
import { Button, Card, LoadMore } from "@lyrashield/ui"
import { findingsPaginatedSchema } from "@/lib/api-schemas"
import { apiGetPaginated } from "@/lib/api-client"
import { FINDING_PLURAL } from "@/lib/terminology"
import { DashboardErrorCard } from "@/components/dashboard-error-card"
import {
  findingFilterToApiQuery,
  findingsHref,
  decodeFindingFilters,
  type FindingFilter as FindingFilterValue,
} from "@/lib/finding-list-params"
import {
  sortFindings,
  updateFindingStatus,
  type FindingListItem,
  type SortMode,
} from "./findings-list-model"
import {
  useFindingsListPopState,
  useFindingsListRestore,
  useFindingsListSave,
} from "./findings-list-effects"

export type { FindingListItem, SortMode } from "./findings-list-model"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FindingsClient
// ---------------------------------------------------------------------------

export function FindingsClient({
  workspaceId,
  initialData,
  initialNextCursor,
  initialSelectedFindingId,
  initialScanId = "",
  initialFilter = "OPEN",
  initialSort = "priority",
  initialTargetFilter = "",
  initialQuery = "",
  targets = [],
  canCreatePr = false,
}: {
  workspaceId: string
  initialData: FindingListItem[]
  initialNextCursor: string | null
  initialSelectedFindingId?: string
  initialScanId?: string
  /** Parsed on the server from the URL; never re-read from window here. */
  initialFilter?: string
  initialSort?: SortMode
  initialTargetFilter?: string
  initialQuery?: string
  targets?: { id: string; name: string }[]
  canCreatePr?: boolean
}) {
  const updateQueryParams = useCallback(
    (updates: { filter?: string; sort?: SortMode; target?: string; q?: string }) => {
      if (typeof window === "undefined") return
      const params = new URLSearchParams(window.location.search)
      if (updates.filter !== undefined) {
        const selection = decodeFindingFilters(updates.filter)
        params.delete("filter")
        params.set("status", selection.status)
        if (selection.severity === "ALL") params.delete("severity")
        else params.set("severity", selection.severity)
        if (selection.evidence === "ALL") params.delete("evidence")
        else params.set("evidence", selection.evidence)
      }
      if (updates.sort !== undefined) {
        if (updates.sort !== "priority") params.set("sort", updates.sort)
        else params.delete("sort")
      }
      if (updates.target !== undefined) {
        params.delete("targetId")
        if (updates.target) params.set("target", updates.target)
        else params.delete("target")
      }
      if (updates.q !== undefined) {
        if (updates.q) params.set("q", updates.q)
        else params.delete("q")
      }
      const search = params.toString()
      const nextUrl = `${window.location.pathname}${search ? `?${search}` : ""}`
      if (nextUrl === `${window.location.pathname}${window.location.search}`) return
      const method =
        updates.filter !== undefined || updates.target !== undefined || updates.sort !== undefined
          ? "pushState"
          : "replaceState"
      window.history[method](null, "", nextUrl)
    },
    []
  )

  const [findings, setFindings] = useState<FindingListItem[]>(initialData)
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor)
  // Initial state comes from the server-parsed URL props, so the first client
  // render matches the server-rendered HTML exactly (no hydration divergence).
  const [filter, setFilter] = useState<string>(initialFilter)
  const [sortMode, setSortMode] = useState<SortMode>(initialSort)
  const [scanId, setScanId] = useState(initialScanId)
  const [targetFilter, setTargetFilter] = useState(initialTargetFilter)
  const [query, setQuery] = useState(initialQuery)
  const {
    selectedFinding,
    setSelectedFinding,
    openerRef,
    openFinding,
    closeFinding,
    clearFindingForScopeChange,
  } = useFindingDrawer(findings, initialData, initialSelectedFindingId)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState(false)
  const [restoreReady, setRestoreReady] = useState(false)
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const requestGenerationRef = useRef(0)
  const requestAbortRef = useRef<AbortController | null>(null)
  const loadMoreAbortRef = useRef<AbortController | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const acceptLoadMoreRef = useRef(false)
  const pendingItemsRef = useRef<FindingListItem[] | null>(null)
  const restoreAbortRef = useRef<AbortController | null>(null)
  const pagesRef = useRef<FindingsListPage[]>([
    { items: initialData, nextCursor: initialNextCursor },
  ])
  const initialScope = JSON.stringify({
    filter: initialFilter,
    scanId: initialScanId,
    target: initialTargetFilter,
    q: initialQuery,
  })
  const loadedScopeRef = useRef(initialScope)
  const currentScopeRef = useRef(initialScope)
  useEffect(() => {
    currentScopeRef.current = JSON.stringify({ filter, scanId, target: targetFilter, q: query })
  }, [filter, scanId, targetFilter, query])

  const fetchFindings = useCallback(async (params: Record<string, string>, generation: number) => {
    if (generation !== requestGenerationRef.current) return
    const abort = new AbortController()
    requestAbortRef.current = abort
    setLoading(true)
    setError(null)
    try {
      const res = await apiGetPaginated<FindingListItem>(`/api/findings`, params, {
        schema: findingsPaginatedSchema,
        signal: abort.signal,
      })
      if (generation !== requestGenerationRef.current) return
      pagesRef.current = [{ items: res.items, nextCursor: res.nextCursor }]
      loadedScopeRef.current = currentScopeRef.current
      setFindings(res.items)
      setNextCursor(res.nextCursor)
    } catch {
      if (generation !== requestGenerationRef.current) return
      loadedScopeRef.current = ""
      setFindings([])
      setError(`Failed to load ${FINDING_PLURAL.toLowerCase()}. Please try again.`)
    } finally {
      if (generation === requestGenerationRef.current) {
        setLoading(false)
        if (requestAbortRef.current === abort) requestAbortRef.current = null
      }
    }
  }, [])

  const invalidateRequest = useCallback(() => {
    clearTimeout(searchTimerRef.current)
    requestAbortRef.current?.abort()
    loadMoreAbortRef.current?.abort()
    restoreAbortRef.current?.abort()
    requestAbortRef.current = null
    setRestoreReady(true)
    return ++requestGenerationRef.current
  }, [])

  // Restore, save and Back/Forward live in ./findings-list-effects; the guards
  // and dependency arrays are unchanged, only their home is.
  useFindingsListRestore({
    workspaceId,
    initialData,
    initialNextCursor,
    initialFilter,
    initialSort,
    initialScanId,
    initialTargetFilter,
    initialQuery,
    setFindings,
    setNextCursor,
    setRestoreError,
    setRestoreReady,
    pagesRef,
    requestGenerationRef,
    restoreAbortRef,
  })
  useFindingsListSave({
    workspaceId,
    filter,
    sortMode,
    scanId,
    targetFilter,
    query,
    findings,
    nextCursor,
    restoreReady,
    pagesRef,
    loadedScopeRef,
    currentScopeRef,
  })
  const applyWebMcpFilter = useCallback(
    async (newFilter: string, newSort: SortMode, externalSignal?: AbortSignal) => {
      currentScopeRef.current = JSON.stringify({
        filter: newFilter,
        scanId,
        target: targetFilter,
        q: query,
      })
      const generation = invalidateRequest()
      setFilter(newFilter)
      setSortMode(newSort)
      updateQueryParams({ filter: newFilter, sort: newSort })
      const abort = new AbortController()
      requestAbortRef.current = abort
      const onExternalAbort = () => abort.abort()
      if (externalSignal?.aborted) abort.abort()
      else externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
      setLoading(true)
      setError(null)
      try {
        const res = await apiGetPaginated<FindingListItem>(
          "/api/findings",
          {
            workspaceId,
            ...findingFilterToApiQuery(newFilter as FindingFilterValue),
            ...(scanId ? { observedInScanId: scanId } : {}),
            ...(targetFilter ? { targetId: targetFilter } : {}),
            ...(query ? { q: query } : {}),
          },
          { schema: findingsPaginatedSchema, signal: abort.signal }
        )
        if (abort.signal.aborted || generation !== requestGenerationRef.current)
          throw new DOMException("Aborted", "AbortError")
        pagesRef.current = [{ items: res.items, nextCursor: res.nextCursor }]
        loadedScopeRef.current = currentScopeRef.current
        setFindings(res.items)
        setNextCursor(res.nextCursor)
        return res.items
      } catch (error) {
        if (generation === requestGenerationRef.current) {
          loadedScopeRef.current = ""
          pagesRef.current = []
          setFindings([])
          setNextCursor(null)
          setError(`Failed to load ${FINDING_PLURAL.toLowerCase()}. Please try again.`)
        }
        throw error
      } finally {
        externalSignal?.removeEventListener("abort", onExternalAbort)
        if (generation === requestGenerationRef.current) {
          setLoading(false)
          if (requestAbortRef.current === abort) requestAbortRef.current = null
        }
      }
    },
    [workspaceId, scanId, targetFilter, query, invalidateRequest, updateQueryParams]
  )

  const { hasUndo: hasWebMcpUndo, undoWebMcpChange } = useFindingsWebMcp({
    workspaceId,
    findings,
    filter,
    sortMode,
    setSortMode,
    setSelectedFinding,
    updateQueryParams,
    applyFilter: applyWebMcpFilter,
  })

  useEffect(
    () => () => {
      clearTimeout(searchTimerRef.current)
      requestAbortRef.current?.abort()
      loadMoreAbortRef.current?.abort()
      restoreAbortRef.current?.abort()
    },
    []
  )

  // Back/Forward lives in ./findings-list-effects; the guard and dependency
  // array are unchanged, and it keeps the position it had between the unmount
  // cleanup above and the list callbacks below.
  useFindingsListPopState({
    workspaceId,
    filter,
    sortMode,
    scanId,
    targetFilter,
    query,
    setFindings,
    setNextCursor,
    setFilter,
    setSortMode,
    setScanId,
    setTargetFilter,
    setQuery,
    setLoading,
    setError,
    pagesRef,
    loadedScopeRef,
    currentScopeRef,
    invalidateRequest,
    fetchFindings,
    clearFindingForScopeChange,
  })

  /** Combined query for the current filter/target/search state. */
  const listQuery = useCallback(
    (extra: Record<string, string> = {}) => ({
      workspaceId,
      ...findingFilterToApiQuery(filter as FindingFilterValue),
      ...(scanId ? { observedInScanId: scanId } : {}),
      ...(targetFilter ? { targetId: targetFilter } : {}),
      ...(query ? { q: query } : {}),
      ...extra,
    }),
    [workspaceId, filter, scanId, targetFilter, query]
  )

  const handleFilterChange = useCallback(
    async (newFilter: string, newQuery = query) => {
      currentScopeRef.current = JSON.stringify({
        filter: newFilter,
        scanId,
        target: targetFilter,
        q: newQuery,
      })
      const generation = invalidateRequest()
      setFilter(newFilter)
      setQuery(newQuery)
      updateQueryParams({ filter: newFilter, sort: sortMode, q: newQuery })
      await fetchFindings(
        {
          workspaceId,
          ...findingFilterToApiQuery(newFilter as FindingFilterValue),
          ...(scanId ? { observedInScanId: scanId } : {}),
          ...(targetFilter ? { targetId: targetFilter } : {}),
          ...(newQuery ? { q: newQuery } : {}),
        },
        generation
      )
    },
    [
      sortMode,
      updateQueryParams,
      invalidateRequest,
      targetFilter,
      query,
      fetchFindings,
      scanId,
      workspaceId,
    ]
  )

  const handleTargetFilterChange = useCallback(
    async (value: string) => {
      currentScopeRef.current = JSON.stringify({ filter, scanId, target: value, q: query })
      const generation = invalidateRequest()
      clearFindingForScopeChange()
      setTargetFilter(value)
      updateQueryParams({ target: value })
      await fetchFindings(
        {
          workspaceId,
          ...findingFilterToApiQuery(filter as FindingFilterValue),
          ...(scanId ? { observedInScanId: scanId } : {}),
          ...(value ? { targetId: value } : {}),
          ...(query ? { q: query } : {}),
        },
        generation
      )
    },
    [
      updateQueryParams,
      fetchFindings,
      invalidateRequest,
      workspaceId,
      filter,
      scanId,
      query,
      clearFindingForScopeChange,
    ]
  )

  // Only user edits schedule a search; hydration and Back/Forward fetch their
  // already-parsed query directly. Filter changes cancel this timer.
  const handleQueryChange = useCallback(
    (value: string) => {
      currentScopeRef.current = JSON.stringify({ filter, scanId, target: targetFilter, q: value })
      const generation = invalidateRequest()
      setQuery(value)
      setLoading(true)
      updateQueryParams({ q: value })
      searchTimerRef.current = setTimeout(() => {
        void fetchFindings(
          {
            workspaceId,
            ...findingFilterToApiQuery(filter as FindingFilterValue),
            ...(scanId ? { observedInScanId: scanId } : {}),
            ...(targetFilter ? { targetId: targetFilter } : {}),
            ...(value ? { q: value } : {}),
          },
          generation
        )
      }, 300)
    },
    [filter, scanId, targetFilter, workspaceId, fetchFindings, invalidateRequest, updateQueryParams]
  )

  const sortedFindings = sortFindings(findings, sortMode)

  // The default filter is Open, so only a non-default filter counts as a
  // narrowing the user chose. A scan scope or target scope always narrows.
  const narrowed = filter !== "OPEN" || Boolean(scanId) || Boolean(targetFilter) || Boolean(query)
  /**
   * Reset every narrowing in one request. Clearing each control separately
   * would fire three fetches whose closures still hold the previous values.
   * A scan scope is fixed by the URL, so that case renders a link instead.
   */
  const clearFindingsFilters = useCallback(() => {
    if (scanId) return
    currentScopeRef.current = JSON.stringify({ filter: "OPEN", scanId: "", target: "", q: "" })
    const generation = invalidateRequest()
    clearFindingForScopeChange()
    setFilter("OPEN")
    setTargetFilter("")
    setQuery("")
    updateQueryParams({ filter: "OPEN", target: "", q: "" })
    void fetchFindings(
      { workspaceId, ...findingFilterToApiQuery("OPEN" as FindingFilterValue) },
      generation
    )
  }, [
    scanId,
    invalidateRequest,
    clearFindingForScopeChange,
    updateQueryParams,
    fetchFindings,
    workspaceId,
  ])

  return (
    <div>
      <FindingsControls
        filter={filter}
        sortMode={sortMode}
        scanId={scanId}
        targetFilter={targetFilter}
        query={query}
        targets={targets}
        handleFilterChange={handleFilterChange}
        handleTargetFilterChange={handleTargetFilterChange}
        handleQueryChange={handleQueryChange}
        setSortMode={setSortMode}
        updateQueryParams={updateQueryParams}
      />
      {hasWebMcpUndo && (
        <Card className="mb-4 flex items-center gap-3 p-3" role="status">
          <span className="text-muted-foreground text-sm">
            Browser agent changed the visible filter or sort.
          </span>
          <Button type="button" size="sm" variant="outline" onClick={undoWebMcpChange}>
            Undo
          </Button>
        </Card>
      )}

      {error && (
        <DashboardErrorCard
          message={error}
          onRetry={() => void fetchFindings(listQuery(), invalidateRequest())}
        />
      )}
      {restoreError && (
        <p role="status" className="text-muted-foreground mb-3 text-sm">
          Could not restore additional results. Use Load more to continue from the current page.
        </p>
      )}

      <FindingsResults
        hasConstraints={Boolean(query || filter !== "ALL")}
        onReset={() => {
          setQuery("")
          void handleFilterChange("ALL", "")
        }}
        reviewScanHref={
          scanId
            ? `/dashboard/scans/${encodeURIComponent(scanId)}`
            : targetFilter
              ? `/dashboard/scans?target=${encodeURIComponent(targetFilter)}`
              : "/dashboard/scans"
        }
        error={Boolean(error)}
        loading={loading}
        findings={findings}
        sortedFindings={sortedFindings}
        rowRefs={rowRefs}
        narrowed={narrowed}
        onClearFilters={clearFindingsFilters}
        clearHref={scanId ? findingsHref({ tab: "issues" }) : undefined}
        onOpenFinding={(finding, button) => {
          openerRef.current = button
          openFinding(finding)
        }}
      >
        {restoreReady && (
          <LoadMore
            key={JSON.stringify([workspaceId, scanId, filter, targetFilter, query])}
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const generation = requestGenerationRef.current
              const abort = new AbortController()
              loadMoreAbortRef.current = abort
              const res = await apiGetPaginated<FindingListItem>(
                `/api/findings`,
                listQuery({ cursor }),
                { schema: findingsPaginatedSchema, signal: abort.signal }
              )
              acceptLoadMoreRef.current =
                generation === requestGenerationRef.current && !abort.signal.aborted
              return { items: res.items, nextCursor: res.nextCursor }
            }}
            onItems={(items) => {
              if (acceptLoadMoreRef.current) {
                pendingItemsRef.current = items
                setFindings((prev) => [...prev, ...items])
              }
            }}
            onNextCursor={(cursor) => {
              if (!acceptLoadMoreRef.current) return
              if (pendingItemsRef.current) {
                pagesRef.current = [
                  ...pagesRef.current,
                  { items: pendingItemsRef.current, nextCursor: cursor },
                ]
                pendingItemsRef.current = null
              }
              setNextCursor(cursor)
              acceptLoadMoreRef.current = false
            }}
          />
        )}
      </FindingsResults>

      {selectedFinding && (
        <FindingDetailDrawer
          canCreatePr={canCreatePr}
          key={`${workspaceId}:${scanId}:${targetFilter}:${selectedFinding.id}`}
          finding={selectedFinding}
          workspaceId={workspaceId}
          targetId={targetFilter || undefined}
          observedInScanId={scanId || undefined}
          onClose={closeFinding}
          onStatusChange={(id, status) => {
            const reprioritize = (f: FindingListItem): FindingListItem =>
              updateFindingStatus(f, id, status)
            pagesRef.current = pagesRef.current.map((page) => ({
              ...page,
              items: page.items.map(reprioritize),
            }))
            setFindings((prev) => prev.map(reprioritize))
            setSelectedFinding((prev) => (prev?.id === id ? reprioritize(prev) : prev))
          }}
        />
      )}
    </div>
  )
}
