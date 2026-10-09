"use client"
import type { ReactNode, RefObject } from "react"
import Link from "next/link"
import { Bug, Shield, ChevronRight, CheckCircle2, XCircle, Calendar, SortDesc } from "lucide-react"
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Select,
  Spinner,
  buttonVariants,
  cn,
} from "@lyrashield/ui"
import { Skeleton } from "@/components/ui/skeleton"
import { severityLabel, humanizeToken } from "@/lib/labels"
import { SEVERITY_BADGE } from "@/lib/severity-badge"
import { FINDING_PLURAL, TARGET_PLURAL, TARGET_SINGULAR } from "@/lib/terminology"
import {
  decodeFindingFilters,
  encodeFindingFilters,
  FINDING_STATUSES,
  FINDING_SEVERITIES,
  FINDING_EVIDENCE,
  type FindingFilters,
  findingsHref,
} from "@/lib/finding-list-params"
import { SEVERITY_ICON, SEVERITY_COLOR } from "./finding-presentation"
import type { FindingListItem, SortMode } from "./findings-client"

type FindingsControlsProps = {
  filter: string
  sortMode: SortMode
  scanId: string
  targetFilter: string
  query: string
  targets: { id: string; name: string }[]
  handleFilterChange: (filter: string) => Promise<void>
  handleTargetFilterChange: (target: string) => Promise<void>
  handleQueryChange: (query: string) => void
  setSortMode: (sort: SortMode) => void
  updateQueryParams: (updates: {
    filter?: string
    sort?: SortMode
    target?: string
    q?: string
  }) => void
}

export function FindingsControls({
  filter,
  sortMode,
  scanId,
  targetFilter,
  query,
  targets,
  handleFilterChange,
  handleTargetFilterChange,
  handleQueryChange,
  setSortMode,
  updateQueryParams,
}: FindingsControlsProps) {
  const selection = decodeFindingFilters(filter)
  const change = (axis: keyof FindingFilters, value: string) =>
    void handleFilterChange(encodeFindingFilters({ ...selection, [axis]: value }))

  return (
    <>
      <div
        aria-label="Findings scope"
        className="mb-5 flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <p>
          <span className="font-medium">Scope:</span>{" "}
          {targetFilter
            ? `Target: ${targets.find((target) => target.id === targetFilter)?.name ?? "Selected target"}`
            : "All targets"}
          {scanId ? ` · Scan: ${scanId}` : ""}
          {!scanId && !targetFilter ? " · All workspace findings" : ""}
        </p>
        {(scanId || targetFilter) && (
          <Link
            href={findingsHref({ tab: "issues" })}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            All workspace findings
          </Link>
        )}
      </div>
      <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
          role="group"
          aria-label="Combine finding filters"
        >
          <label className="space-y-1 text-xs font-medium">
            Status
            <Select
              aria-label="Filter by status"
              value={selection.status}
              onChange={(e) => change("status", e.target.value)}
              className="h-11 w-full"
            >
              {FINDING_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value === "ALL" ? "All statuses" : humanizeToken(value)}
                </option>
              ))}
            </Select>
          </label>
          <label className="space-y-1 text-xs font-medium">
            Severity
            <Select
              aria-label="Filter by severity"
              value={selection.severity}
              onChange={(e) => change("severity", e.target.value)}
              className="h-11 w-full"
            >
              {FINDING_SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {value === "ALL" ? "All severities" : severityLabel(value)}
                </option>
              ))}
            </Select>
          </label>
          <label className="space-y-1 text-xs font-medium">
            Evidence
            <Select
              aria-label="Filter by evidence"
              value={selection.evidence}
              onChange={(e) => change("evidence", e.target.value)}
              className="h-11 w-full"
            >
              {FINDING_EVIDENCE.map((value) => (
                <option key={value} value={value}>
                  {value === "ALL"
                    ? "All evidence states"
                    : value === "VERIFIED"
                      ? "Independently verified"
                      : "Not independently verified"}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {targets.length > 0 && (
            <Select
              aria-label={`Filter by ${TARGET_SINGULAR.toLowerCase()}`}
              value={targetFilter}
              onChange={(e) => void handleTargetFilterChange(e.target.value)}
              disabled={Boolean(scanId)}
              className="h-11 w-full sm:w-44"
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
            placeholder={`Search ${FINDING_PLURAL.toLowerCase()}…`}
            aria-label={`Search ${FINDING_PLURAL.toLowerCase()}`}
            className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring h-11 w-full rounded-md border px-3 text-base focus-visible:ring-2 focus-visible:outline-none md:h-9 md:text-sm lg:w-56"
          />

          {/* Sort control */}
          <div className="flex w-full min-w-0 max-w-full items-center gap-1 rounded-xl border px-3 sm:w-auto">
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
              className="text-muted-foreground focus-visible:ring-ring min-h-11 min-w-0 flex-1 cursor-pointer rounded-sm bg-transparent text-xs font-medium focus-visible:ring-2 focus-visible:outline-none sm:flex-none"
            >
              <option value="priority">Priority (recommended)</option>
              <option value="severity">Severity (high first)</option>
              <option value="newest">Newest</option>
            </select>
          </div>
        </div>
      </div>
    </>
  )
}

type FindingsResultsProps = {
  loading: boolean
  hasConstraints?: boolean
  onReset?: () => void
  error?: boolean
  reviewScanHref?: string
  findings: FindingListItem[]
  sortedFindings: FindingListItem[]
  rowRefs: RefObject<Map<string, HTMLButtonElement | null>>
  onOpenFinding: (finding: FindingListItem, button: HTMLButtonElement) => void
  /**
   * True when the current list is narrowed by anything the user can undo: a
   * status filter other than the default, a target, a scan scope or a search.
   * A narrowed empty result is not an empty workspace, and telling a user who
   * just fixed everything to "start a scan" is wrong.
   */
  narrowed?: boolean
  onClearFilters?: () => void
  /** When the empty result is caused by a scan scope, the way out is a link. */
  clearHref?: string
  children?: ReactNode
}

export function FindingsResults({
  loading,
  hasConstraints = false,
  onReset,
  error = false,
  reviewScanHref = "/dashboard/scans",
  findings,
  sortedFindings,
  rowRefs,
  onOpenFinding,
  narrowed = false,
  onClearFilters,
  clearHref,
  children,
}: FindingsResultsProps) {
  return (
    <>
      {loading && findings.length === 0 ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label={`Loading ${FINDING_PLURAL.toLowerCase()}`}
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-32 w-full" />
          ))}
        </div>
      ) : error ? null : findings.length === 0 ? (
        <EmptyState
          icon={Bug}
          title={hasConstraints || narrowed ? "No matching findings" : "No findings in this scope"}
          description={
            hasConstraints
              ? "No findings match the selected status, severity, evidence, or search. Reset filters to see all findings within the current target and scan scope."
              : narrowed
                ? "Nothing in this workspace matches the current target or scan. Clear the scope to see all findings."
                : "No findings are recorded in the current scope. Review your scans for assessment status and coverage; an empty list alone does not establish readiness."
          }
          action={
            hasConstraints && onReset ? (
              <Button onClick={onReset} variant="outline">
                Reset filters and search
              </Button>
            ) : narrowed && clearHref ? (
              <Link href={clearHref} className={buttonVariants({ variant: "outline" })}>
                Clear filters
              </Link>
            ) : narrowed && onClearFilters ? (
              <Button variant="outline" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : (
              <Link href={reviewScanHref} className={buttonVariants({ variant: "outline" })}>
                Review scans
              </Link>
            )
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
                    onOpenFinding(finding, event.currentTarget)
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
                        <span className="flex items-center gap-1 text-xs text-emerald-800 dark:text-emerald-400">
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

          {children}
        </div>
      )}
    </>
  )
}
