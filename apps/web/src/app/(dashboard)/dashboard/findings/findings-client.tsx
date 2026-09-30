"use client"
import { useState, useEffect, useCallback, useRef } from "react"
import { useFindingsWebMcp } from "./findings-webmcp"
import { FindingDetailDrawer } from "./finding-detail-drawer"
import { FindingsControls, FindingsResults } from "./findings-client-view"
import { useFindingDrawer } from "./use-finding-drawer"
import {
  findingsContextKey,
  loadFindingsListContext,
  saveFindingsListContext,
  type FindingsListPage,
} from "./findings-list-context"
import { Button, Card, LoadMore } from "@lyrashield/ui"
import { findingsPaginatedSchema } from "@/lib/api-schemas"
import { apiGetPaginated } from "@/lib/api-client"
import { FINDING_PLURAL } from "@/lib/terminology"
import { DashboardErrorCard } from "@/components/dashboard-error-card"
import {
  findingFilterToApiQuery,
  parseFindingListParams,
  type FindingFilter as FindingFilterValue,
} from "@/lib/finding-list-params"
import {
  sortFindings,
  updateFindingStatus,
  type FindingListItem,
  type SortMode,
} from "./findings-list-model"

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
        // No filter parameter means Open, so All must be written explicitly.
        if (updates.filter !== "OPEN") params.set("filter", updates.filter)
        else params.delete("filter")
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

  // Server props own page one. Saved pages only tell us how many additional
  // pages to re-fetch through fresh cursors before restoring scroll.
  useEffect(() => {
    const abort = new AbortController()
    restoreAbortRef.current = abort
    queueMicrotask(() => {
      void (async () => {
        try {
          const stored = loadFindingsListContext(
            findingsContextKey(workspaceId, {
              filter: initialFilter,
              sort: initialSort,
              scanId: initialScanId,
              target: initialTargetFilter,
              q: initialQuery,
            })
          )
          if (!stored) return
          const restoreScroll = () => {
            if (stored.scrollY > 0)
              requestAnimationFrame(() => {
                if (!abort.signal.aborted && requestGenerationRef.current === 0)
                  window.scrollTo(0, stored.scrollY)
              })
          }
          if (stored.pages.length < 2 || !initialNextCursor) {
            restoreScroll()
            return
          }
          const pages: FindingsListPage[] = [{ items: initialData, nextCursor: initialNextCursor }]
          let cursor: string | null = initialNextCursor
          for (let index = 1; index < stored.pages.length && cursor; index++) {
            const result: FindingsListPage = await apiGetPaginated<FindingListItem>(
              "/api/findings",
              {
                workspaceId,
                ...findingFilterToApiQuery(initialFilter as FindingFilterValue),
                ...(initialScanId ? { observedInScanId: initialScanId } : {}),
                ...(initialTargetFilter ? { targetId: initialTargetFilter } : {}),
                ...(initialQuery ? { q: initialQuery } : {}),
                cursor,
              },
              { schema: findingsPaginatedSchema, signal: abort.signal }
            )
            if (abort.signal.aborted || requestGenerationRef.current !== 0) return
            if (!result.items.length) break
            if (
              pages.reduce((count, page) => count + page.items.length, 0) + result.items.length >
              500
            )
              break
            pages.push(result)
            cursor = result.nextCursor
          }
          if (abort.signal.aborted || requestGenerationRef.current !== 0) return
          pagesRef.current = pages
          setFindings(pages.flatMap((page) => page.items))
          setNextCursor(cursor)
          restoreScroll()
        } catch {
          if (!abort.signal.aborted) setRestoreError(true)
        } finally {
          if (!abort.signal.aborted) setRestoreReady(true)
        }
      })()
    })
    return () => abort.abort()
    // Restore once per mount with the URL-derived context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Never save the previous query's rows under a newly selected query key.
  useEffect(() => {
    if (
      !restoreReady ||
      loadedScopeRef.current !== currentScopeRef.current ||
      typeof window === "undefined"
    )
      return
    const save = () =>
      saveFindingsListContext(
        findingsContextKey(workspaceId, {
          filter,
          sort: sortMode,
          scanId,
          target: targetFilter,
          q: query,
        }),
        { pages: pagesRef.current, scrollY: window.scrollY }
      )
    save()
    window.addEventListener("pagehide", save)
    return () => window.removeEventListener("pagehide", save)
  }, [
    workspaceId,
    filter,
    sortMode,
    scanId,
    targetFilter,
    query,
    findings,
    nextCursor,
    restoreReady,
  ])

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
    async (newFilter: string) => {
      currentScopeRef.current = JSON.stringify({
        filter: newFilter,
        scanId,
        target: targetFilter,
        q: query,
      })
      const generation = invalidateRequest()
      setFilter(newFilter)
      updateQueryParams({ filter: newFilter, sort: sortMode })
      await fetchFindings(
        {
          workspaceId,
          ...findingFilterToApiQuery(newFilter as FindingFilterValue),
          ...(scanId ? { observedInScanId: scanId } : {}),
          ...(targetFilter ? { targetId: targetFilter } : {}),
          ...(query ? { q: query } : {}),
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

  useEffect(() => {
    const onPopState = () => {
      const params = parseFindingListParams(
        Object.fromEntries(new URLSearchParams(window.location.search))
      )
      const scopeChanged = params.scanId !== scanId || params.target !== targetFilter
      if (params.scopeValid && !scopeChanged && params.filter === filter && params.q === query) {
        if (params.sort !== sortMode) setSortMode(params.sort)
        return
      }
      currentScopeRef.current = JSON.stringify({
        filter: params.filter,
        scanId: params.scanId,
        target: params.target,
        q: params.q,
      })
      const generation = invalidateRequest()
      if (scopeChanged) clearFindingForScopeChange()
      setFilter(params.filter)
      setSortMode(params.sort)
      setScanId(params.scanId)
      setTargetFilter(params.target)
      setQuery(params.q)
      if (!params.scopeValid) {
        pagesRef.current = []
        loadedScopeRef.current = ""
        setFindings([])
        setNextCursor(null)
        setLoading(false)
        setError(
          "Selected scan or target is unavailable in this workspace. Clear the scope to continue."
        )
        return
      }
      void fetchFindings(
        {
          workspaceId,
          ...findingFilterToApiQuery(params.filter),
          ...(params.scanId ? { observedInScanId: params.scanId } : {}),
          ...(params.target ? { targetId: params.target } : {}),
          ...(params.q ? { q: params.q } : {}),
        },
        generation
      )
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [
    workspaceId,
    filter,
    sortMode,
    scanId,
    targetFilter,
    query,
    invalidateRequest,
    fetchFindings,
    clearFindingForScopeChange,
  ])

  const sortedFindings = sortFindings(findings, sortMode)

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
        loading={loading}
        findings={findings}
        sortedFindings={sortedFindings}
        rowRefs={rowRefs}
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
