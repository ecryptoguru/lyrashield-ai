"use client"
import { useState, useEffect, useCallback, useRef } from "react"
import { useFindingsWebMcp } from "./findings-webmcp"
import { FindingDetailDrawer } from "./finding-detail-drawer"
import {
  findingsContextKey,
  loadFindingsListContext,
  saveFindingsListContext,
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
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${search ? `?${search}` : ""}`
      )
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
  // The row that opened the drawer, for focus restoration on close.
  const openerRef = useRef<HTMLElement | null>(null)
  const pushedFindingUrlRef = useRef(false)
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>())
  const requestGenerationRef = useRef(0)
  const acceptLoadMoreRef = useRef(false)

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

  // W2-12 context restoration: the URL carries filter/sort/target/query, but
  // pages loaded beyond the first server-rendered page and the scroll position
  // only survive navigation through this session-scoped snapshot. The first
  // client render still matches the server HTML; restoration is queued (not
  // synchronous) so hydration stays clean and the save effect below never
  // overwrites the snapshot with the bare first page.
  const listContextRestoredRef = useRef(false)
  useEffect(() => {
    queueMicrotask(() => {
      if (typeof window === "undefined") return
      const current = { filter, sort: sortMode, target: targetFilter, q: query }
      // The context key encodes filter/sort/target/query, so any stored
      // snapshot under this key already matches the URL-derived list state.
      const stored = loadFindingsListContext(findingsContextKey(workspaceId, current))
      if (stored) {
        setFindings(stored.rows)
        setNextCursor(stored.nextCursor)
        if (stored.scrollY > 0) requestAnimationFrame(() => window.scrollTo(0, stored.scrollY))
      }
      // The save effect below must not run until restoration has been
      // attempted, otherwise the bare first page overwrites the snapshot.
      listContextRestoredRef.current = true
    })
    // Restore once per mount with the URL-derived context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist the loaded list (rows, cursor, scroll) for the current context so
  // returning to Findings restores it. Skipped until the restore pass has run
  // so the snapshot is never overwritten with the bare first page.
  useEffect(() => {
    if (!listContextRestoredRef.current || typeof window === "undefined") return
    const save = () =>
      saveFindingsListContext(
        findingsContextKey(workspaceId, { filter, sort: sortMode, target: targetFilter, q: query }),
        {
          rows: findings,
          nextCursor,
          scrollY: window.scrollY,
        }
      )
    save()
    window.addEventListener("pagehide", save)
    return () => window.removeEventListener("pagehide", save)
  }, [workspaceId, filter, sortMode, targetFilter, query, findings, nextCursor])

  const { hasUndo: hasWebMcpUndo, undoWebMcpChange } = useFindingsWebMcp({
    workspaceId,
    findings,
    nextCursor,
    filter,
    sortMode,
    initialData,
    initialNextCursor,
    setFilter,
    setSortMode,
    setFindings,
    setNextCursor,
    setSelectedFinding,
    setError,
    updateQueryParams,
  })

  const fetchFindings = useCallback(async (params: Record<string, string>, generation: number) => {
    if (generation !== requestGenerationRef.current) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiGetPaginated<FindingListItem>(`/api/findings`, params, {
        schema: findingsPaginatedSchema,
      })
      if (generation !== requestGenerationRef.current) return
      setFindings(res.items)
      setNextCursor(res.nextCursor)
    } catch {
      if (generation !== requestGenerationRef.current) return
      setFindings([])
      setError(`Failed to load ${ISSUE_PLURAL.toLowerCase()}. Please try again.`)
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false)
    }
  }, [])

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
      const generation = ++requestGenerationRef.current
      setFilter(newFilter)
      updateQueryParams({ filter: newFilter, sort: sortMode })
      // Reset to the server-rendered page only when returning to the exact
      // state the server delivered; otherwise fetch the new view. Compare the
      // derived query objects field-wise — two freshly-allocated objects are
      // never === equal, which previously made this branch unreachable and
      // forced a refetch (discarding loaded pages) even when the filter
      // matched the server render.
      const sameDerivedQuery =
        JSON.stringify(findingFilterToApiQuery(newFilter as FindingFilterValue)) ===
        JSON.stringify(findingFilterToApiQuery(initialFilter as FindingFilterValue))
      if (newFilter === initialFilter && !targetFilter && !query && sameDerivedQuery) {
        setFindings(initialData)
        setNextCursor(initialNextCursor)
        setError(null)
        return
      }
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
      initialFilter,
      initialData,
      initialNextCursor,
      targetFilter,
      query,
      fetchFindings,
      workspaceId,
    ]
  )

  const handleTargetFilterChange = useCallback(
    async (value: string) => {
      const generation = ++requestGenerationRef.current
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
    [updateQueryParams, fetchFindings, workspaceId, filter, query]
  )

  // Bounded server-side search: debounced so typing does not spam the API.
  useEffect(() => {
    if (query === initialQuery) return
    const generation = requestGenerationRef.current
    const timer = window.setTimeout(() => {
      updateQueryParams({ q: query })
      void fetchFindings(
        {
          workspaceId,
          ...findingFilterToApiQuery(filter as FindingFilterValue),
          ...(targetFilter ? { targetId: targetFilter } : {}),
          ...(query ? { q: query } : {}),
        },
        generation
      )
    }, 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const handleQueryChange = useCallback((value: string) => {
    requestGenerationRef.current += 1
    setQuery(value)
  }, [])

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
        <DashboardErrorCard message={error} onRetry={() => void handleFilterChange(filter)} />
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

          <LoadMore
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const generation = requestGenerationRef.current
              const res = await apiGetPaginated<FindingListItem>(
                `/api/findings`,
                listQuery({ cursor }),
                { schema: findingsPaginatedSchema }
              )
              acceptLoadMoreRef.current = generation === requestGenerationRef.current
              return { items: res.items, nextCursor: res.nextCursor }
            }}
            onItems={(items) => {
              if (acceptLoadMoreRef.current) setFindings((prev) => [...prev, ...items])
            }}
            onNextCursor={(cursor) => {
              if (!acceptLoadMoreRef.current) return
              setNextCursor(cursor)
              acceptLoadMoreRef.current = false
            }}
          />
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
            setFindings((prev) => prev.map(reprioritize))
            setSelectedFinding((prev) => (prev?.id === id ? reprioritize(prev) : prev))
          }}
        />
      )}
    </div>
  )
}
