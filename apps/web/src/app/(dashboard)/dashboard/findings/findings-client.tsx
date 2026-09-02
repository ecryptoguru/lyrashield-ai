"use client"
import { CreateFixPrAction } from "@/components/create-fix-pr-action"

import { useState, useEffect, useCallback, useRef, useId } from "react"
import { useFindingsWebMcp } from "./findings-webmcp"
import { z } from "zod"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import Link from "next/link"
import {
  Bug,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Shield,
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Wrench,
  ArrowRight,
  Calendar,
  SortDesc,
} from "lucide-react"
import {
  Button,
  Badge,
  Card,
  EmptyState,
  Spinner,
  LoadMore,
  Select,
  Textarea,
  FormField,
  buttonVariants,
  cn,
} from "@lyrashield/ui"
import { paginatedResponseSchema } from "@/lib/api-schemas"
import { apiGet, apiGetPaginated, apiPost, apiPatch } from "@/lib/api-client"
import { formatDate } from "@/lib/date-format"
import {
  ISSUE_PLURAL,
  RUN_PLURAL,
  RUN_SINGULAR,
  TARGET_PLURAL,
  TARGET_SINGULAR,
} from "@/lib/terminology"
import { getFindingNextStep } from "@/lib/finding-next-step"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { severityLabel, humanizeToken } from "@/lib/labels"
import { calculateFindingPriority, type FindingPriorityResult } from "@/lib/finding-priority"
import type { FindingStatus, TargetEnvironment } from "@lyrashield/types"
import {
  findingFilterToApiQuery,
  type FindingFilter as FindingFilterValue,
} from "@/lib/finding-list-params"

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

const prioritySchema = z
  .object({
    score: z.number(),
    band: z.enum(["urgent", "high", "normal", "low"]),
    reasons: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .passthrough()

const findingTargetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    environment: z.string().nullable().optional(),
  })
  .passthrough()

const findingListItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]),
    status: z.string(),
    verified: z.boolean(),
    verificationStatus: z.string(),
    verificationMethod: z.string().nullable().optional(),
    verificationReason: z.string().nullable().optional(),
    confidence: z.string(),
    cwe: z.string().nullable().optional(),
    cvssScore: z.number().nullable().optional(),
    businessImpact: z.string().nullable().optional(),
    exploitability: z.string().nullable().optional(),
    target: findingTargetSchema.nullable().optional(),
    _count: z
      .object({
        evidence: z.number(),
        fixProposals: z.number(),
      })
      .passthrough()
      .optional(),
    priority: prioritySchema.optional(),
    firstSeenAt: z.string().datetime().or(z.string()),
    lastSeenAt: z.string().datetime().or(z.string()),
  })
  .passthrough()

const findingsPaginatedSchema = paginatedResponseSchema(findingListItemSchema)

type BadgeVariant = "default" | "success" | "danger" | "warning" | "info" | "muted"

const SEVERITY_BADGE: Record<string, BadgeVariant> = {
  CRITICAL: "danger",
  HIGH: "danger",
  MEDIUM: "warning",
  LOW: "info",
  INFO: "muted",
}

const STATUS_BADGE: Record<string, BadgeVariant> = {
  OPEN: "danger",
  FIX_READY: "info",
  PR_OPENED: "info",
  FIXED: "success",
  FIXED_PENDING_RETEST: "success",
  ACCEPTED_RISK: "muted",
  FALSE_POSITIVE: "muted",
  DUPLICATE: "muted",
}

// ---------------------------------------------------------------------------
// Severity icons — mirrors scan-detail-client.tsx SEVERITY_ICON (WCAG 1.4.1)
// ---------------------------------------------------------------------------

const SEVERITY_ICON: Record<string, typeof Shield> = {
  CRITICAL: ShieldX,
  HIGH: ShieldAlert,
  MEDIUM: Shield,
  LOW: ShieldCheck,
  INFO: ShieldCheck,
}

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "text-destructive",
  HIGH: "text-orange-600 dark:text-orange-400",
  MEDIUM: "text-amber-600 dark:text-amber-400",
  LOW: "text-sky-600 dark:text-sky-400",
  INFO: "text-muted-foreground",
}

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractEpssPercentage(technicalDetail?: string | null): string | undefined {
  const marker = "FIRST EPSS: "
  const valueStart = technicalDetail?.indexOf(marker) ?? -1
  if (!technicalDetail || valueStart < 0) return undefined

  const start = valueStart + marker.length
  const end = technicalDetail.indexOf("%", start)
  if (end < start || end - start > 6) return undefined

  const percentage = technicalDetail.slice(start, end)
  return Number.isFinite(Number(percentage)) ? `${percentage}%` : undefined
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

  // Deep-link hygiene: once a ?finding= deep link has been consumed by the
  // server render, replace the history entry WITHOUT the param. Without this,
  // opening another finding (pushState) and closing it pops back to the
  // original deep-link entry — whose popstate handler would re-open the
  // deep-linked finding instead of returning to the clean list.
  useEffect(() => {
    if (!initialSelectedFindingId || typeof window === "undefined") return
    const url = new URL(window.location.href)
    if (!url.searchParams.has("finding")) return
    url.searchParams.delete("finding")
    window.history.replaceState(null, "", `${url.pathname}${url.search}`)
    // Run once on mount: the deep link is consumed exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
            placeholder="Search issues…"
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
        <Card className="border-destructive/50 mb-4 p-4">
          <div className="text-destructive flex items-center gap-2 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => void handleFilterChange(filter)}
            >
              Retry
            </Button>
          </div>
        </Card>
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

// ---------------------------------------------------------------------------
// Audience mode — client-side reframing
// ---------------------------------------------------------------------------

type AudienceMode = "founder" | "developer" | "security-engineer" | "enterprise-admin" | "auditor"

const AUDIENCE_LABELS: Record<AudienceMode, string> = {
  founder: "Founder / CEO",
  developer: "Developer",
  "security-engineer": "Security Engineer",
  "enterprise-admin": "Enterprise Admin",
  auditor: "Auditor",
}

/**
 * Returns a short mode-specific lead-in paragraph to prepend to the
 * plain-language content. The underlying facts are identical — only the
 * framing emphasis changes. This is a purely client-side reframe.
 *
 * SEAM: When the API gains per-mode server content, replace this function
 * with a fetch to /api/findings/[id]/explain?mode=[mode] and remove the
 * client-side construction below.
 */
function getAudienceLeadIn(mode: AudienceMode, severity: string, title: string): string {
  switch (mode) {
    case "founder":
      return `As a business leader, this ${severity.toLowerCase()} finding ("${title}") represents a risk to your product, customers, or compliance posture. Your engineering team can resolve it — the key action is prioritising and tracking it.`
    case "developer":
      return `This is a ${severity.toLowerCase()} finding in your codebase. The steps below give you a direct path to fix it. Focus on the "How to fix" section for implementation guidance.`
    case "security-engineer":
      return `${severity} severity finding. Review CWE, CVSS, and EPSS data in the Technical tab for triage. The fix guidance below is a starting point — validate against your threat model.`
    case "enterprise-admin":
      return `This ${severity.toLowerCase()} finding may affect compliance, SLAs, or vendor risk assessments. Ensure it is assigned to an owner and that resolution is tracked against your remediation SLA.`
    case "auditor":
      return `For audit purposes, this ${severity.toLowerCase()} finding ("${title}") should be referenced in your risk register. Verification receipts and retest history are available in the History tab.`
  }
}

// ---------------------------------------------------------------------------
// Finding detail types
// ---------------------------------------------------------------------------

interface PlainLanguage {
  title: string
  whatItIs: string
  whyItMatters: string
  howToFix: string
  difficulty: string
  estimatedTimeToFix: string
}

interface FindingDetail {
  id: string
  title: string
  summary: string
  category?: string | null
  cwe?: string | null
  cvssScore?: number | null
  technicalDetail?: string | null
  recommendedFix?: string | null
  businessImpact?: string | null
  exploitability?: string | null
  verificationStatus?: string
  verificationMethod?: string | null
  verificationReason?: string | null
  statusReason?: string | null
  verificationReceipts?: Array<{
    id: string
    status: string
    method: string
    reason: string
    scanId: string
    sourceRevision: string | null
    verifierVersion: string | null
    evidence: unknown
    createdAt: string
  }>
  evidence?: Array<{ id: string; type: string; redactionStatus: string }>
  fixProposals?: Array<{ id: string; status: string; summary: string }>
  retests?: Array<{ id: string; scanId: string; status: string; createdAt: string }>
  scanId?: string | null
  plainLanguage?: PlainLanguage
}

// Strict client-side guard for the retest receipt evidence persisted by the
// worker. Unknown or historical evidence shapes stay renderable as the generic
// receipt below and are never trusted as this shape.
const retestReceiptEvidenceSchema = z
  .object({
    retestId: z.string(),
    scannerSource: z.string(),
    baseline: z
      .object({
        scanId: z.string(),
        manifestChecksum: z.string(),
        sourceRevision: z.string().nullable(),
        targetUrlChecksum: z.string().nullable(),
      })
      .nullable(),
    retest: z
      .object({
        scanId: z.string(),
        manifestChecksum: z.string(),
        sourceRevision: z.string().nullable(),
        targetUrlChecksum: z.string().nullable(),
      })
      .nullable(),
    coverageReceiptIds: z.array(z.string()),
  })
  .passthrough()

function parseRetestReceipt(evidence: unknown) {
  const parsed = retestReceiptEvidenceSchema.safeParse(evidence)
  return parsed.success ? parsed.data : null
}

const retestResultSchema = z
  .object({
    scan: z.object({ id: z.string(), status: z.string() }).passthrough(),
  })
  .passthrough()

const findingPatchResultSchema = z
  .object({
    id: z.string(),
    status: z.string(),
  })
  .passthrough()

const findingDetailSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    category: z.string().nullable().optional(),
    cwe: z.string().nullable().optional(),
    cvssScore: z.number().nullable().optional(),
    technicalDetail: z.string().nullable().optional(),
    recommendedFix: z.string().nullable().optional(),
    businessImpact: z.string().nullable().optional(),
    exploitability: z.string().nullable().optional(),
    verificationStatus: z.string().optional(),
    verificationMethod: z.string().nullable().optional(),
    verificationReason: z.string().nullable().optional(),
    statusReason: z.string().nullable().optional(),
    scanId: z.string().nullable().optional(),
    verificationReceipts: z
      .array(
        z
          .object({
            id: z.string(),
            status: z.string(),
            method: z.string(),
            reason: z.string(),
            scanId: z.string(),
            sourceRevision: z.string().nullable(),
            verifierVersion: z.string().nullable(),
            evidence: z.unknown(),
            createdAt: z.string().datetime().or(z.string()),
          })
          .passthrough()
      )
      .optional(),
    evidence: z
      .array(
        z
          .object({
            id: z.string(),
            type: z.string(),
            redactionStatus: z.string(),
          })
          .passthrough()
      )
      .optional(),
    fixProposals: z
      .array(
        z
          .object({
            id: z.string(),
            status: z.string(),
            summary: z.string(),
          })
          .passthrough()
      )
      .optional(),
    retests: z
      .array(
        z
          .object({
            id: z.string(),
            scanId: z.string(),
            status: z.string(),
            createdAt: z.string().datetime().or(z.string()),
          })
          .passthrough()
      )
      .optional(),
    plainLanguage: z
      .object({
        title: z.string(),
        whatItIs: z.string(),
        whyItMatters: z.string(),
        howToFix: z.string(),
        difficulty: z.string(),
        estimatedTimeToFix: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

// ---------------------------------------------------------------------------
// StatusActionConfirm — inline confirm with required comment
// ---------------------------------------------------------------------------

/**
 * Inline confirm panel for status-transition actions (accept risk / false positive).
 * The comment field is required client-side for intentionality and is persisted
 * as the finding's statusReason via the /api/findings/[id] PATCH body.
 */
function StatusActionConfirm({
  label,
  confirmLabel,
  onConfirm,
  onCancel,
  isLoading,
  error,
}: {
  label: string
  confirmLabel: string
  onConfirm: (comment: string) => void | Promise<void>
  onCancel: () => void
  isLoading: boolean
  error: string | null
}) {
  const [comment, setComment] = useState("")
  const trimmed = comment.trim()
  // useId: two confirm panels can technically be mounted at once (the
  // drawer's action states are not structurally exclusive), and a duplicated
  // static id breaks label association for screen readers.
  const commentFieldId = useId()

  return (
    <div
      className="bg-muted/40 mt-2 space-y-2 rounded-lg border p-3"
      role="group"
      aria-label={label}
    >
      <FormField label={label} htmlFor={commentFieldId}>
        <Textarea
          id={commentFieldId}
          rows={2}
          placeholder="Add a comment explaining your decision (required)…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          aria-required="true"
          className="w-full"
          autoFocus
        />
      </FormField>
      {error && <p className="text-destructive text-xs">{error}</p>}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={isLoading || trimmed.length === 0}
          onClick={() => void onConfirm(trimmed)}
        >
          {isLoading ? <Spinner /> : confirmLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={isLoading}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// FindingDetailDrawer
// ---------------------------------------------------------------------------

function FindingDetailDrawer({
  canCreatePr,
  finding,
  workspaceId,
  onClose,
  onStatusChange,
}: {
  canCreatePr: boolean
  finding: FindingListItem
  workspaceId: string
  onClose: () => void
  onStatusChange: (id: string, status: string) => void
}) {
  const [detail, setDetail] = useState<FindingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [drawerError, setDrawerError] = useState<string | null>(null)
  const [showFixForm, setShowFixForm] = useState(false)
  const [fixSummary, setFixSummary] = useState("")
  const [creatingFix, setCreatingFix] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [creatingRetest, setCreatingRetest] = useState(false)
  const [retestError, setRetestError] = useState<string | null>(null)
  const [queuedRetestScanId, setQueuedRetestScanId] = useState<string | null>(null)

  // Status transitions
  const [showAcceptRisk, setShowAcceptRisk] = useState(false)
  const [showFalsePositive, setShowFalsePositive] = useState(false)
  const [patchLoading, setPatchLoading] = useState(false)
  const [patchError, setPatchError] = useState<string | null>(null)

  // Audience mode for "What to do" tab
  const [audienceMode, setAudienceMode] = useState<AudienceMode>("developer")

  const knownExploited = detail?.technicalDetail?.includes("CISA KEV:") ?? false
  const epssSummary = extractEpssPercentage(detail?.technicalDetail)

  const fetchDetail = useCallback(
    (signal?: AbortSignal) =>
      apiGet(`/api/findings/${finding.id}?workspaceId=${workspaceId}`, {
        schema: findingDetailSchema,
        ...(signal ? { signal } : {}),
      }),
    [finding.id, workspaceId]
  )

  useEffect(() => {
    // A different finding selection remounts this drawer (keyed by finding id),
    // and the unmount abort cancels the superseded request in flight.
    const controller = new AbortController()
    let cancelled = false
    fetchDetail(controller.signal)
      .then((res) => {
        if (cancelled) return
        setDetail(res ?? null)
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return
        setDetail(null)
        setDrawerError(err instanceof Error ? err.message : "Failed to load finding details.")
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [fetchDetail])

  const handleRetry = useCallback(() => {
    setLoading(true)
    setDrawerError(null)
    fetchDetail()
      .then((res) => setDetail(res ?? null))
      .catch((err) => {
        setDetail(null)
        setDrawerError(err instanceof Error ? err.message : "Failed to load finding details.")
      })
      .finally(() => setLoading(false))
  }, [fetchDetail])

  const latestRetest = detail?.retests?.[0] ?? null
  const hasFixProposal = (detail?.fixProposals?.length ?? 0) > 0
  const nextStep = getFindingNextStep({
    latestRetestStatus: latestRetest?.status,
    hasFixProposal,
  })

  async function queueRetest() {
    if (!detail?.scanId) return
    setCreatingRetest(true)
    setRetestError(null)
    try {
      const result = await apiPost(
        `/api/findings/${finding.id}/retests`,
        { workspaceId },
        { schema: retestResultSchema }
      )
      setQueuedRetestScanId(result.scan.id)
      const res = await apiGet(`/api/findings/${finding.id}?workspaceId=${workspaceId}`, {
        schema: findingDetailSchema,
      })
      setDetail(res ?? null)
    } catch (err) {
      setRetestError(err instanceof Error ? err.message : "Failed to create retest")
    } finally {
      setCreatingRetest(false)
    }
  }

  async function handleAcceptRisk(comment: string) {
    setPatchLoading(true)
    setPatchError(null)
    try {
      const result = await apiPatch(
        `/api/findings/${finding.id}`,
        {
          workspaceId,
          action: "accept_risk",
          reason: comment,
        },
        { schema: findingPatchResultSchema }
      )
      onStatusChange(finding.id, result.status)
      setShowAcceptRisk(false)
      const res = await apiGet(`/api/findings/${finding.id}?workspaceId=${workspaceId}`, {
        schema: findingDetailSchema,
      })
      setDetail(res ?? null)
    } catch (err) {
      setPatchError(err instanceof Error ? err.message : "Failed to update status")
    } finally {
      setPatchLoading(false)
    }
  }

  async function handleFalsePositive(comment: string) {
    setPatchLoading(true)
    setPatchError(null)
    try {
      const result = await apiPatch(
        `/api/findings/${finding.id}`,
        {
          workspaceId,
          action: "false_positive",
          reason: comment,
        },
        { schema: findingPatchResultSchema }
      )
      onStatusChange(finding.id, result.status)
      setShowFalsePositive(false)
      const res = await apiGet(`/api/findings/${finding.id}?workspaceId=${workspaceId}`, {
        schema: findingDetailSchema,
      })
      setDetail(res ?? null)
    } catch (err) {
      setPatchError(err instanceof Error ? err.message : "Failed to update status")
    } finally {
      setPatchLoading(false)
    }
  }

  const SevIcon = SEVERITY_ICON[finding.severity] ?? Shield
  const isResolved = finding.status === "ACCEPTED_RISK" || finding.status === "FALSE_POSITIVE"

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-lg overflow-y-auto p-6 sm:max-w-lg">
        <SheetHeader className="mb-4 p-0 pr-8 text-left">
          {/* Breadcrumb inside drawer */}
          <nav aria-label="Breadcrumb" className="mb-1">
            <ol className="text-muted-foreground flex items-center gap-1 text-xs">
              <li>
                <Link href="/dashboard/findings" className="hover:text-foreground">
                  Findings
                </Link>
              </li>
              <li aria-hidden="true">
                <ChevronRight className="h-3 w-3" />
              </li>
              <li className="text-foreground max-w-50 truncate font-medium" title={finding.title}>
                {finding.title}
              </li>
            </ol>
          </nav>
          <SheetTitle>{finding.title}</SheetTitle>
          <SheetDescription className="sr-only">
            Finding evidence, verification state, remediation, and retest actions
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          // Stable skeleton matching the final layout: badges, tabs, and the
          // content blocks the drawer will occupy — no spinner-only state.
          <div className="space-y-4" aria-busy="true" aria-label="Loading issue details">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-9 w-full" />
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
          </div>
        ) : drawerError ? (
          <div
            className="bg-destructive/5 border-destructive/20 rounded-lg border p-4"
            role="alert"
          >
            <div className="text-destructive flex items-center gap-2 text-sm font-medium">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {drawerError}
            </div>
            <div className="mt-3 flex gap-2">
              <Button type="button" size="sm" onClick={() => void handleRetry()}>
                Retry
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : detail ? (
          <div className="space-y-4">
            {/* Badges row */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Severity with icon — WCAG 1.4.1 */}
              <Badge variant={SEVERITY_BADGE[finding.severity] ?? "muted"}>
                <SevIcon
                  className={cn("mr-1 h-3 w-3", SEVERITY_COLOR[finding.severity])}
                  aria-hidden="true"
                />
                {severityLabel(finding.severity)}
              </Badge>
              <Badge variant={STATUS_BADGE[finding.status] ?? "muted"}>
                {finding.status.replace(/_/g, " ")}
              </Badge>
              {finding.verified ? (
                <Badge variant="success">
                  <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
                  Verified
                </Badge>
              ) : (
                <Badge variant="muted">{finding.verificationStatus.replaceAll("_", " ")}</Badge>
              )}
              {finding.confidence && <Badge variant="muted">{finding.confidence} confidence</Badge>}
            </div>

            {/* "View scan" cross-link when scanId is available */}
            {detail.scanId && (
              <Link
                href={`/dashboard/scans/${encodeURIComponent(detail.scanId)}`}
                className="text-primary inline-flex items-center gap-1 text-xs font-medium hover:underline"
              >
                <Shield className="h-3 w-3" aria-hidden="true" />
                View scan
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            )}

            {/* ----------------------------------------------------------------
                TABBED LAYOUT
                Tab 1: What to do  (plain language + audience mode + next step)
                Tab 2: Technical   (technical details, CWE, CVSS, EPSS, evidence)
                Tab 3: History     (retests, fix proposals, verification receipts)
            ----------------------------------------------------------------- */}
            <Tabs defaultValue="what-to-do" className="w-full">
              <TabsList className="w-full">
                <TabsTrigger value="what-to-do" className="flex-1">
                  What to do
                </TabsTrigger>
                <TabsTrigger value="technical" className="flex-1">
                  Technical
                </TabsTrigger>
                <TabsTrigger value="history" className="flex-1">
                  History
                </TabsTrigger>
              </TabsList>

              {/* ============================================================
                  TAB 1: What to do
              ============================================================ */}
              <TabsContent value="what-to-do" className="mt-4 space-y-4">
                {/* Audience mode selector */}
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="audience-mode"
                    className="text-muted-foreground shrink-0 text-xs font-medium"
                  >
                    Audience:
                  </label>
                  <select
                    id="audience-mode"
                    value={audienceMode}
                    onChange={(e) => setAudienceMode(e.target.value as AudienceMode)}
                    className="bg-background focus:ring-ring rounded-md border px-2 py-1 text-xs focus:ring-2 focus:outline-none"
                    aria-label="Select audience mode for plain-language explanation"
                  >
                    {(Object.entries(AUDIENCE_LABELS) as [AudienceMode, string][]).map(
                      ([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      )
                    )}
                  </select>
                </div>

                {/* Next-step action panel */}
                <div className="border-primary/30 bg-primary/5 rounded-lg border p-4">
                  <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                    Next step
                  </p>
                  {nextStep === "REPORT" && latestRetest ? (
                    <div className="mt-2">
                      <h3 className="font-semibold">
                        Turn the retest result into an assurance report
                      </h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        This fresh retest passed. Generate an immutable report from its retained
                        result.
                      </p>
                      <Link
                        href={`/dashboard/findings?tab=reports&scanId=${encodeURIComponent(latestRetest.scanId)}`}
                        className={buttonVariants({ size: "sm", className: "mt-3" })}
                      >
                        Generate report
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </Link>
                    </div>
                  ) : nextStep === "RETEST_IN_PROGRESS" && latestRetest ? (
                    <div className="mt-2">
                      <h3 className="font-semibold">Retest in progress</h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        The fresh scan will determine whether the recorded change is
                        retest-confirmed or remains inconclusive.
                      </p>
                      <Link
                        href={`/dashboard/scans/${encodeURIComponent(latestRetest.scanId)}`}
                        className={buttonVariants({
                          variant: "secondary",
                          size: "sm",
                          className: "mt-3",
                        })}
                      >
                        View retest
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </Link>
                    </div>
                  ) : showFixForm ? (
                    <div className="mt-3 space-y-3">
                      <div>
                        <h3 className="font-semibold">Create a fix proposal</h3>
                        <p className="text-muted-foreground mt-1 text-sm">
                          Review and edit this plan before saving it. Creating a proposal does not
                          change your code.
                        </p>
                      </div>
                      <FormField label="Fix summary" htmlFor="fix-summary">
                        <Textarea
                          id="fix-summary"
                          className="w-full"
                          rows={4}
                          placeholder="Describe the change you intend to make..."
                          value={fixSummary}
                          onChange={(e) => setFixSummary(e.target.value)}
                        />
                      </FormField>
                      {fixError && <p className="text-destructive text-xs">{fixError}</p>}
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={creatingFix || fixSummary.trim().length < 10}
                          onClick={async () => {
                            setCreatingFix(true)
                            setFixError(null)
                            try {
                              await apiPost(`/api/findings/${finding.id}/fix-proposals`, {
                                workspaceId,
                                summary: fixSummary.trim(),
                              })
                              setShowFixForm(false)
                              setFixSummary("")
                              const res = await apiGet(
                                `/api/findings/${finding.id}?workspaceId=${workspaceId}`,
                                { schema: findingDetailSchema }
                              )
                              setDetail(res ?? null)
                            } catch (err) {
                              setFixError(
                                err instanceof Error ? err.message : "Failed to create fix proposal"
                              )
                            } finally {
                              setCreatingFix(false)
                            }
                          }}
                        >
                          {creatingFix ? <Spinner /> : "Save proposal"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setShowFixForm(false)
                            setFixSummary("")
                            setFixError(null)
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : nextStep === "RETEST" ? (
                    <div className="mt-2">
                      <h3 className="font-semibold">Apply the change, then run a fresh retest</h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        The proposal is recorded, but LyraShield has not changed your code. Queue
                        the retest only after you apply the fix.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {!detail.scanId ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-block">
                                <Button type="button" size="sm" disabled>
                                  Queue fresh retest
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              A fresh retest needs a linked server scan. Run a scan for this target
                              first, or check that this finding came from a completed scan rather
                              than an imported report.
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            disabled={creatingRetest}
                            onClick={() => void queueRetest()}
                          >
                            {creatingRetest ? (
                              <span className="flex items-center gap-2">
                                <Spinner /> Queuing retest...
                              </span>
                            ) : (
                              "Queue fresh retest"
                            )}
                          </Button>
                        )}
                      </div>
                      {retestError && (
                        <p className="text-destructive mt-2 text-xs">{retestError}</p>
                      )}
                    </div>
                  ) : (
                    <div className="mt-2">
                      <h3 className="font-semibold">Review the guidance and record your plan</h3>
                      <p className="text-muted-foreground mt-1 text-sm">
                        Use the evidence and recommended fix below, then save the change you intend
                        to make.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        className="mt-3"
                        onClick={() => {
                          setFixSummary(
                            detail.recommendedFix ?? detail.plainLanguage?.howToFix ?? ""
                          )
                          setFixError(null)
                          setShowFixForm(true)
                        }}
                      >
                        <Wrench className="mr-1 size-4" aria-hidden="true" />
                        Create fix proposal
                      </Button>
                    </div>
                  )}
                  {queuedRetestScanId && nextStep !== "RETEST_IN_PROGRESS" && (
                    <Link
                      href={`/dashboard/scans/${encodeURIComponent(queuedRetestScanId)}`}
                      className="text-primary mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium hover:underline"
                    >
                      View queued retest
                      <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                  )}
                </div>

                {/* Summary */}
                <div>
                  <h3 className="mb-1 text-sm font-medium">Summary</h3>
                  <p className="text-muted-foreground text-sm">{detail.summary}</p>
                </div>

                {/* Plain-language explanation with audience mode lead-in */}
                {detail.plainLanguage && (
                  <div className="bg-muted/30 rounded-lg border p-4">
                    <p className="text-sm font-semibold">Plain-Language Explanation</p>
                    {/* Audience-mode lead-in — client-side reframe of same facts.
                        SEAM: replace with per-mode server content when API supports it. */}
                    <p className="text-muted-foreground border-primary/30 mt-2 border-l-2 pl-2 text-xs italic">
                      {getAudienceLeadIn(audienceMode, finding.severity, finding.title)}
                    </p>
                    <div className="mt-3 space-y-3">
                      <div>
                        <p className="text-muted-foreground mb-0.5 text-xs font-medium">
                          What it is
                        </p>
                        <p className="text-sm">{detail.plainLanguage.whatItIs}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-0.5 text-xs font-medium">
                          Why it matters
                        </p>
                        <p className="text-sm">{detail.plainLanguage.whyItMatters}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground mb-0.5 text-xs font-medium">
                          How to fix
                        </p>
                        <p className="text-sm">{detail.plainLanguage.howToFix}</p>
                      </div>
                      <div className="text-muted-foreground flex items-center gap-3 pt-1 text-xs">
                        <span>
                          Difficulty:{" "}
                          <span className="font-medium">{detail.plainLanguage.difficulty}</span>
                        </span>
                        <span>
                          Est. time:{" "}
                          <span className="font-medium">
                            {detail.plainLanguage.estimatedTimeToFix}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Status transition actions — Accept risk / Mark false positive */}
                {!isResolved && (
                  <div className="space-y-2 border-t pt-2">
                    <p className="text-muted-foreground text-xs font-medium">Risk decisions</p>
                    <div className="flex flex-wrap gap-2">
                      {!showAcceptRisk && !showFalsePositive && (
                        <>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setShowAcceptRisk(true)
                              setShowFalsePositive(false)
                              setPatchError(null)
                            }}
                          >
                            Accept risk
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setShowFalsePositive(true)
                              setShowAcceptRisk(false)
                              setPatchError(null)
                            }}
                          >
                            Mark false positive
                          </Button>
                        </>
                      )}
                    </div>
                    {showAcceptRisk && (
                      <StatusActionConfirm
                        label="Accept risk — this finding will be acknowledged but not fixed."
                        confirmLabel="Accept risk"
                        onConfirm={handleAcceptRisk}
                        onCancel={() => {
                          setShowAcceptRisk(false)
                          setPatchError(null)
                        }}
                        isLoading={patchLoading}
                        error={patchError}
                      />
                    )}
                    {showFalsePositive && (
                      <StatusActionConfirm
                        label="Mark as false positive — this finding will be dismissed."
                        confirmLabel="Mark false positive"
                        onConfirm={handleFalsePositive}
                        onCancel={() => {
                          setShowFalsePositive(false)
                          setPatchError(null)
                        }}
                        isLoading={patchLoading}
                        error={patchError}
                      />
                    )}
                  </div>
                )}
                {isResolved && (
                  <div className="bg-muted/30 text-muted-foreground rounded-md border px-3 py-2 text-xs">
                    This finding is marked as{" "}
                    <span className="font-medium">{finding.status.replace(/_/g, " ")}</span>.
                  </div>
                )}
              </TabsContent>

              {/* ============================================================
                  TAB 2: Technical
              ============================================================ */}
              <TabsContent value="technical" className="mt-4 space-y-4">
                {/* Metadata badges */}
                {(detail.cwe ||
                  detail.cvssScore != null ||
                  detail.category ||
                  knownExploited ||
                  epssSummary) && (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {knownExploited && <Badge variant="danger">Known exploited · CISA KEV</Badge>}
                    {epssSummary && <Badge variant="warning">EPSS {epssSummary}</Badge>}
                    {detail.cwe && <Badge variant="info">{detail.cwe}</Badge>}
                    {detail.cvssScore != null && (
                      <Badge variant="warning">CVSS {detail.cvssScore}</Badge>
                    )}
                    {detail.category && <Badge variant="muted">{detail.category}</Badge>}
                  </div>
                )}

                {detail.exploitability && (
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Exploitability</h3>
                    <p className="text-muted-foreground text-sm">{detail.exploitability}</p>
                  </div>
                )}

                {detail.recommendedFix && (
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Recommended Fix</h3>
                    <p className="text-muted-foreground text-sm">{detail.recommendedFix}</p>
                  </div>
                )}

                {detail.businessImpact && (
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Business Impact</h3>
                    <p className="text-muted-foreground text-sm">{detail.businessImpact}</p>
                  </div>
                )}

                {detail.technicalDetail && (
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Technical Details</h3>
                    <pre
                      className="bg-muted mt-1 overflow-x-auto rounded-lg p-3 text-xs whitespace-pre-wrap"
                      tabIndex={0}
                      aria-label="Technical details"
                    >
                      {detail.technicalDetail}
                    </pre>
                  </div>
                )}

                {detail.evidence && detail.evidence.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      Evidence ({detail.evidence.length})
                    </h3>
                    <div className="space-y-2">
                      {detail.evidence.map((ev) => (
                        <div
                          key={ev.id}
                          className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm"
                        >
                          <div className="flex items-center gap-2">
                            <Badge variant="muted">{ev.type}</Badge>
                          </div>
                          <Badge
                            variant={ev.redactionStatus === "complete" ? "success" : "warning"}
                          >
                            {ev.redactionStatus}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {detail.verificationReason && (
                  <div className="bg-muted/30 rounded-lg border p-3">
                    <h3 className="text-sm font-medium">Verification state</h3>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {detail.verificationReason}
                    </p>
                  </div>
                )}

                {detail.statusReason && (
                  <div className="bg-muted/30 rounded-lg border p-3">
                    <h3 className="text-sm font-medium">Status reason</h3>
                    <p className="text-muted-foreground mt-1 text-sm">{detail.statusReason}</p>
                  </div>
                )}

                {!detail.technicalDetail &&
                  !detail.exploitability &&
                  !detail.cwe &&
                  !detail.cvssScore &&
                  !detail.category &&
                  !detail.evidence?.length && (
                    <p className="text-muted-foreground text-sm">
                      No technical details are available for this finding.
                    </p>
                  )}
              </TabsContent>

              {/* ============================================================
                  TAB 3: History
              ============================================================ */}
              <TabsContent value="history" className="mt-4 space-y-4">
                {detail.retests && detail.retests.length > 0 ? (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">Retests ({detail.retests.length})</h3>
                    <div className="space-y-2">
                      {detail.retests.map((rt) => (
                        <div key={rt.id} className="flex items-center gap-2 text-sm">
                          <Badge
                            variant={
                              rt.status === "passed"
                                ? "success"
                                : rt.status === "failed"
                                  ? "danger"
                                  : "info"
                            }
                          >
                            {rt.status}
                          </Badge>
                          <Link
                            href={`/dashboard/scans/${encodeURIComponent(rt.scanId)}`}
                            className="text-primary text-xs hover:underline"
                          >
                            View scan
                          </Link>
                          <span className="text-muted-foreground text-xs">
                            {formatDate(rt.createdAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">No retests recorded yet.</p>
                )}

                {detail.fixProposals && detail.fixProposals.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      Fix Proposals ({detail.fixProposals.length})
                    </h3>
                    <div className="space-y-2">
                      {detail.fixProposals.map((fp) => (
                        <div key={fp.id} className="space-y-2 text-sm">
                          <Badge variant="info">{humanizeToken(fp.status)}</Badge>
                          <span className="text-muted-foreground">{fp.summary}</span>
                          {canCreatePr &&
                            (fp.status === "ready" ||
                              (finding.status === "FIX_READY" &&
                                ["draft", "approved"].includes(fp.status))) && (
                              <CreateFixPrAction workspaceId={workspaceId} proposalId={fp.id} />
                            )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {detail.verificationReceipts && detail.verificationReceipts.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">
                      Verification Receipts ({detail.verificationReceipts.length})
                    </h3>
                    <div className="space-y-2">
                      {detail.verificationReceipts.map((receipt) => {
                        const retestEvidence = parseRetestReceipt(receipt.evidence)
                        const validated = receipt.status === "VALIDATED"
                        return (
                          <div key={receipt.id} className="rounded-lg border p-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant={validated ? "success" : "muted"}>
                                {receipt.status.replaceAll("_", " ")}
                              </Badge>
                              <Badge variant="muted">{receipt.method.replaceAll("_", " ")}</Badge>
                              <span className="text-muted-foreground text-xs">
                                {formatDate(receipt.createdAt)}
                              </span>
                            </div>
                            <p className="text-muted-foreground mt-1 text-xs">{receipt.reason}</p>
                            {retestEvidence && (
                              <div className="text-muted-foreground mt-2 space-y-1 border-t pt-2 text-xs">
                                <p>
                                  Scanner source:{" "}
                                  <span className="font-mono">{retestEvidence.scannerSource}</span>
                                </p>
                                <p>
                                  Coverage:{" "}
                                  <span className={validated ? "text-emerald-500" : ""}>
                                    {validated ? "complete" : "insufficient"}
                                  </span>
                                </p>
                                {retestEvidence.baseline && (
                                  <p>
                                    Baseline scan:{" "}
                                    <Link
                                      href={`/dashboard/scans/${encodeURIComponent(retestEvidence.baseline.scanId)}`}
                                      className="text-primary hover:underline"
                                    >
                                      {retestEvidence.baseline.scanId}
                                    </Link>{" "}
                                    · manifest{" "}
                                    <span className="font-mono">
                                      {retestEvidence.baseline.manifestChecksum}
                                    </span>
                                  </p>
                                )}
                                {retestEvidence.retest && (
                                  <p>
                                    Retest scan:{" "}
                                    <Link
                                      href={`/dashboard/scans/${encodeURIComponent(retestEvidence.retest.scanId)}`}
                                      className="text-primary hover:underline"
                                    >
                                      {retestEvidence.retest.scanId}
                                    </Link>{" "}
                                    · manifest{" "}
                                    <span className="font-mono">
                                      {retestEvidence.retest.manifestChecksum}
                                    </span>
                                  </p>
                                )}
                                {retestEvidence.baseline?.sourceRevision ||
                                retestEvidence.retest?.sourceRevision ? (
                                  <p>
                                    Repository revisions: baseline{" "}
                                    <span className="font-mono">
                                      {retestEvidence.baseline?.sourceRevision ?? "unavailable"}
                                    </span>{" "}
                                    · retest{" "}
                                    <span className="font-mono">
                                      {retestEvidence.retest?.sourceRevision ?? "unavailable"}
                                    </span>
                                  </p>
                                ) : null}
                                {retestEvidence.baseline?.targetUrlChecksum ||
                                retestEvidence.retest?.targetUrlChecksum ? (
                                  <p>
                                    URL checksum: baseline{" "}
                                    <span className="font-mono">
                                      {retestEvidence.baseline?.targetUrlChecksum ?? "unavailable"}
                                    </span>{" "}
                                    · retest{" "}
                                    <span className="font-mono">
                                      {retestEvidence.retest?.targetUrlChecksum ?? "unavailable"}
                                    </span>
                                  </p>
                                ) : null}
                                {retestEvidence.coverageReceiptIds.length > 0 && (
                                  <p>
                                    Coverage receipts:{" "}
                                    <span className="font-mono">
                                      {retestEvidence.coverageReceiptIds.join(", ")}
                                    </span>
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {!detail.retests?.length &&
                  !detail.fixProposals?.length &&
                  !detail.verificationReceipts?.length && (
                    <p className="text-muted-foreground text-sm">
                      No history available for this finding yet.
                    </p>
                  )}
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">Failed to load finding details.</p>
        )}
      </SheetContent>
    </Sheet>
  )
}
