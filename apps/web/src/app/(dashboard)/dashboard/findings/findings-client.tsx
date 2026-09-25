"use client"
import { useState, useEffect, useCallback, useRef } from "react"
import { useFindingsWebMcp } from "./findings-webmcp"
import { FindingDetailDrawer } from "./finding-detail-drawer"
import {
  findingsContextKey,
  loadFindingsListContext,
  saveFindingsListContext,
  type FindingsListPage,
} from "./findings-list-context"
import Link from "next/link"
import { Bug, Shield, ChevronRight, CheckCircle2, XCircle, Calendar, SortDesc } from "lucide-react"
import {
  Button,
  Badge,
  Card,
  EmptyState,
  Spinner,
  LoadMore,
  Select,
  buttonVariants,
  cn,
} from "@lyrashield/ui"
import { findingsPaginatedSchema } from "@/lib/api-schemas"
import { apiGetPaginated } from "@/lib/api-client"
import {
  ISSUE_PLURAL,
  RUN_PLURAL,
  RUN_SINGULAR,
  TARGET_PLURAL,
  TARGET_SINGULAR,
} from "@/lib/terminology"
import { SEVERITY_BADGE } from "@/lib/severity-badge"
import { DashboardErrorCard } from "@/components/dashboard-error-card"
import { Skeleton } from "@/components/ui/skeleton"
import { severityLabel, humanizeToken } from "@/lib/labels"
import { calculateFindingPriority, type FindingPriorityResult } from "@/lib/finding-priority"
import type { FindingStatus, TargetEnvironment } from "@lyrashield/types"
import {
  findingFilterToApiQuery,
  parseFindingListParams,
  type FindingFilter as FindingFilterValue,
} from "@/lib/finding-list-params"
import { SEVERITY_ICON, SEVERITY_COLOR, SEVERITY_ORDER } from "./finding-presentation"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FindingListItem {
  id: string
  title: string
  summary: string
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"
  status: string
  verified: boolean
  verificationStatus: string
  verificationMethod?: string | null
  verificationReason?: string | null
  confidence: string
  cwe?: string | null
  cvssScore?: number | null
  businessImpact?: string | null
  exploitability?: string | null
  target?: { id: string; name: string; type: string; environment?: string | null } | null
  _count?: { evidence: number; fixProposals: number }
  firstSeenAt: string
  lastSeenAt: string
  priority?: FindingPriorityResult
}

// ---------------------------------------------------------------------------
// FindingsClient
// ---------------------------------------------------------------------------

export type SortMode = "priority" | "severity" | "newest"

export function FindingsClient({
  workspaceId,
  initialData,
  initialNextCursor,
  initialSelectedFindingId,
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
  const [targetFilter, setTargetFilter] = useState(initialTargetFilter)
  const [query, setQuery] = useState(initialQuery)
  const [selectedFinding, setSelectedFinding] = useState<FindingListItem | null>(() =>
    initialSelectedFindingId
      ? (initialData.find((finding) => finding.id === initialSelectedFindingId) ?? null)
      : null
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState(false)
  const [restoreReady, setRestoreReady] = useState(false)
  // The row that opened the drawer, for focus restoration on close.
  const openerRef = useRef<HTMLElement | null>(null)
  const pushedFindingUrlRef = useRef(false)
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
    target: initialTargetFilter,
    q: initialQuery,
  })
  const loadedScopeRef = useRef(initialScope)
  const currentScopeRef = useRef(initialScope)
  useEffect(() => {
    currentScopeRef.current = JSON.stringify({ filter, target: targetFilter, q: query })
  }, [filter, targetFilter, query])

  /**
   * Drawer URL state: opening writes `finding=` (pushState, so Back returns to
   * the list), closing removes only `finding=` and restores focus to the row
   * that opened the drawer. Filter/sort/search state is never touched.
   */
  const openFinding = useCallback((finding: FindingListItem) => {
    setSelectedFinding(finding)
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    url.searchParams.set("finding", finding.id)
    window.history.pushState(null, "", `${url.pathname}${url.search}`)
    pushedFindingUrlRef.current = true
  }, [])

  const closeFinding = useCallback(() => {
    const opener = openerRef.current
    setSelectedFinding(null)
    openerRef.current = null
    if (typeof window === "undefined") return
    if (pushedFindingUrlRef.current) {
      pushedFindingUrlRef.current = false
      // Back pops the pushed entry; the popstate listener keeps state in sync.
      window.history.back()
    } else {
      const url = new URL(window.location.href)
      url.searchParams.delete("finding")
      window.history.replaceState(null, "", `${url.pathname}${url.search}`)
    }
    // Restore focus to the row that opened the drawer.
    requestAnimationFrame(() => opener?.focus())
  }, [])

  // Browser Back from a drawer deep link or an opened drawer returns to the
  // list state without losing filter/sort/search.
  useEffect(() => {
    const onPopState = () => {
      pushedFindingUrlRef.current = false
      const findingId = new URL(window.location.href).searchParams.get("finding")
      setSelectedFinding(
        findingId ? (findings.find((finding) => finding.id === findingId) ?? null) : null
      )
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [findings])

  // Keep the drawer deep link on refresh. closeFinding removes it explicitly.

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
        findingsContextKey(workspaceId, { filter, sort: sortMode, target: targetFilter, q: query }),
        { pages: pagesRef.current, scrollY: window.scrollY }
      )
    save()
    window.addEventListener("pagehide", save)
    return () => window.removeEventListener("pagehide", save)
  }, [workspaceId, filter, sortMode, targetFilter, query, findings, nextCursor, restoreReady])

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
      setError(`Failed to load ${ISSUE_PLURAL.toLowerCase()}. Please try again.`)
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
          setError(`Failed to load ${ISSUE_PLURAL.toLowerCase()}. Please try again.`)
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
    [workspaceId, targetFilter, query, invalidateRequest, updateQueryParams]
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
      ...(targetFilter ? { targetId: targetFilter } : {}),
      ...(query ? { q: query } : {}),
      ...extra,
    }),
    [workspaceId, filter, targetFilter, query]
  )

  const handleFilterChange = useCallback(
    async (newFilter: string) => {
      currentScopeRef.current = JSON.stringify({
        filter: newFilter,
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
      workspaceId,
    ]
  )

  const handleTargetFilterChange = useCallback(
    async (value: string) => {
      currentScopeRef.current = JSON.stringify({ filter, target: value, q: query })
      const generation = invalidateRequest()
      setTargetFilter(value)
      updateQueryParams({ target: value })
      await fetchFindings(
        {
          workspaceId,
          ...findingFilterToApiQuery(filter as FindingFilterValue),
          ...(value ? { targetId: value } : {}),
          ...(query ? { q: query } : {}),
        },
        generation
      )
    },
    [updateQueryParams, fetchFindings, invalidateRequest, workspaceId, filter, query]
  )

  // Only user edits schedule a search; hydration and Back/Forward fetch their
  // already-parsed query directly. Filter changes cancel this timer.
  const handleQueryChange = useCallback(
    (value: string) => {
      currentScopeRef.current = JSON.stringify({ filter, target: targetFilter, q: value })
      const generation = invalidateRequest()
      setQuery(value)
      setLoading(true)
      updateQueryParams({ q: value })
      searchTimerRef.current = setTimeout(() => {
        void fetchFindings(
          {
            workspaceId,
            ...findingFilterToApiQuery(filter as FindingFilterValue),
            ...(targetFilter ? { targetId: targetFilter } : {}),
            ...(value ? { q: value } : {}),
          },
          generation
        )
      }, 300)
    },
    [filter, targetFilter, workspaceId, fetchFindings, invalidateRequest, updateQueryParams]
  )

  useEffect(() => {
    const onPopState = () => {
      const params = parseFindingListParams(
        Object.fromEntries(new URLSearchParams(window.location.search))
      )
      if (params.filter === filter && params.target === targetFilter && params.q === query) {
        if (params.sort !== sortMode) setSortMode(params.sort)
        return
      }
      currentScopeRef.current = JSON.stringify({
        filter: params.filter,
        target: params.target,
        q: params.q,
      })
      const generation = invalidateRequest()
      setFilter(params.filter)
      setSortMode(params.sort)
      setTargetFilter(params.target)
      setQuery(params.q)
      void fetchFindings(
        {
          workspaceId,
          ...findingFilterToApiQuery(params.filter),
          ...(params.target ? { targetId: params.target } : {}),
          ...(params.q ? { q: params.q } : {}),
        },
        generation
      )
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [workspaceId, filter, sortMode, targetFilter, query, invalidateRequest, fetchFindings])

  // Client-side sort — priority first (the API-ranked page default), then
  // severity high-first, then newest. Each mode keeps its own tie-breakers so
  // ordering stays deterministic across accumulated pages.
  const sortedFindings = [...findings].sort((a, b) => {
    if (sortMode === "priority") {
      return (
        (b.priority?.score ?? -1) - (a.priority?.score ?? -1) ||
        (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99) ||
        new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
      )
    }
    if (sortMode === "severity") {
      return (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
    }
    // newest = lastSeenAt desc
    return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()
  })

  const filterChips = [
    { label: "Open", value: "OPEN" },
    { label: "All", value: "ALL" },
    { label: "Critical", value: "CRITICAL" },
    { label: "High", value: "HIGH" },
    { label: "Medium", value: "MEDIUM" },
    { label: "Fixed", value: "FIXED" },
    { label: "Verified", value: "VERIFIED" },
  ] as const

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {filterChips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              aria-pressed={filter === chip.value}
              onClick={() => void handleFilterChange(chip.value)}
              className={cn(
                "min-h-11 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === chip.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {targets.length > 0 && (
            <Select
              aria-label={`Filter by ${TARGET_SINGULAR.toLowerCase()}`}
              value={targetFilter}
              onChange={(e) => void handleTargetFilterChange(e.target.value)}
              className="h-9 w-44"
            >
              <option value="">All {TARGET_PLURAL.toLowerCase()}</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </Select>
          )}
          <input
            type="search"
            value={query}
            maxLength={120}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder={`Search ${ISSUE_PLURAL.toLowerCase()}…`}
            aria-label={`Search ${ISSUE_PLURAL.toLowerCase()}`}
            className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none lg:w-56"
          />

          {/* Sort control */}
          <div className="flex items-center gap-1 rounded-full border px-3 py-1">
            <span className="text-muted-foreground text-xs">Sort loaded results</span>
            {sortMode === "severity" ? (
              <SortDesc className="text-muted-foreground h-3 w-3" aria-hidden="true" />
            ) : (
              <Calendar className="text-muted-foreground h-3 w-3" aria-hidden="true" />
            )}
            <select
              value={sortMode}
              onChange={(e) => {
                const next = e.target.value as SortMode
                setSortMode(next)
                updateQueryParams({ filter, sort: next })
              }}
              aria-label="Sort loaded results"
              title="Sort loaded results"
              className="text-muted-foreground focus-visible:ring-ring cursor-pointer rounded-sm bg-transparent text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
            >
              <option value="priority">Priority (recommended)</option>
              <option value="severity">Severity (high first)</option>
              <option value="newest">Newest</option>
            </select>
          </div>
        </div>
      </div>

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

      {loading && findings.length === 0 ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label={`Loading ${ISSUE_PLURAL.toLowerCase()}`}
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-32 w-full" />
          ))}
        </div>
      ) : findings.length === 0 ? (
        <EmptyState
          icon={Bug}
          title={`No ${ISSUE_PLURAL.toLowerCase()} yet`}
          description={`Security ${ISSUE_PLURAL.toLowerCase()} detected by ${RUN_PLURAL.toLowerCase()} will appear here. Start a ${RUN_SINGULAR.toLowerCase()} to get started.`}
          action={
            <Link href="/dashboard/scans" className={buttonVariants()}>
              Start a {RUN_SINGULAR.toLowerCase()}
            </Link>
          }
        />
      ) : (
        <div className={`space-y-3 ${loading ? "pointer-events-none opacity-50" : ""}`}>
          {loading && (
            <div className="flex items-center justify-center py-4">
              <Spinner />
            </div>
          )}
          {sortedFindings.map((finding) => {
            const SevIcon = SEVERITY_ICON[finding.severity] ?? Shield
            const priorityReason = finding.priority?.reasons[0]
            return (
              <Card key={finding.id} className="p-0 transition-shadow hover:shadow-card-hover">
                {/* One semantic control per row: the title button opens the
                    drawer. No nested links, buttons, or disclosures inside it. */}
                <button
                  type="button"
                  ref={(el) => {
                    rowRefs.current.set(finding.id, el)
                  }}
                  onClick={(event) => {
                    openerRef.current = event.currentTarget
                    openFinding(finding)
                  }}
                  aria-haspopup="dialog"
                  className="flex w-full items-start justify-between gap-4 rounded-xl p-4 text-left focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      {/* Severity with icon (WCAG 1.4.1) */}
                      <Badge variant={SEVERITY_BADGE[finding.severity] ?? "muted"}>
                        <SevIcon
                          className={cn("mr-1 h-3 w-3", SEVERITY_COLOR[finding.severity])}
                          aria-hidden="true"
                        />
                        {severityLabel(finding.severity)}
                      </Badge>
                      {finding.verified ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-500">
                          <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Independently
                          verified
                        </span>
                      ) : (
                        <span className="text-muted-foreground flex items-center gap-1 text-xs">
                          <XCircle className="h-3 w-3" aria-hidden="true" />{" "}
                          {humanizeToken(finding.verificationStatus)}
                        </span>
                      )}
                    </div>
                    <span className="block truncate font-medium" title={finding.title}>
                      {finding.title}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-xs">
                      {finding.target ? `${finding.target.name} · ` : ""}
                      {priorityReason ?? humanizeToken(finding.status)}
                    </span>
                  </div>
                  <ChevronRight
                    className="text-muted-foreground mt-1 h-5 w-5 shrink-0"
                    aria-hidden="true"
                  />
                </button>
              </Card>
            )
          })}

          {restoreReady && (
            <LoadMore
              key={JSON.stringify([workspaceId, filter, targetFilter, query])}
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
        </div>
      )}

      {selectedFinding && (
        <FindingDetailDrawer
          canCreatePr={canCreatePr}
          key={selectedFinding.id}
          finding={selectedFinding}
          workspaceId={workspaceId}
          onClose={closeFinding}
          onStatusChange={(id, status) => {
            const reprioritize = (f: FindingListItem): FindingListItem =>
              f.id === id
                ? {
                    ...f,
                    status,
                    priority: calculateFindingPriority({
                      severity: f.severity,
                      status: status as FindingStatus,
                      verified: f.verified,
                      confidence: f.confidence,
                      environment: (f.target?.environment ?? null) as TargetEnvironment | null,
                      businessImpact: f.businessImpact,
                      exploitability: f.exploitability,
                    }),
                  }
                : f
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
