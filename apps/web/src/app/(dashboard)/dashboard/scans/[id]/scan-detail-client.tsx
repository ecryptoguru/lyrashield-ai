"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import Link from "next/link"
import {
  ArrowLeft,
  ArrowRight,
  Radar,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Shield,
  Clock,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react"
import { Card, Badge, Button, EmptyState, buttonVariants } from "@lyrashield/ui"
import { formatTime } from "@/lib/date-format"
import { getScannerCoverageWarnings } from "@/lib/scan-coverage"
import { getScanPresentation, isActiveScan } from "@/lib/scan-presentation"
import { getScanReviewProfile } from "@/lib/scan-review-profile"
import { z } from "zod"
import { paginatedResponseSchema } from "@/lib/api-schemas"
import { apiGetConditional, apiGetPaginated } from "@/lib/api-client"
import { getScanGoalLabel, getScanModeLabel, getScanTriggerLabel } from "@/lib/enum-labels"
import { ScanInProgress } from "./scan-in-progress"
import { AiSecurityScoreCard } from "./ai-score-card"
import { severityLabel } from "@/lib/labels"

interface ScanEvent {
  id: string
  stage: string
  level: string
  message: string
  metadata?: Record<string, unknown> | null
  createdAt: string
}

interface ScanData {
  id: string
  workspaceId: string
  status: string
  goal: string
  mode: string
  triggerType: string
  startedAt: string | null
  endedAt: string | null
  summary: string | null
  errorCategory: string | null
  errorMessage: string | null
  createdAt: string
  target: {
    id: string
    name: string
    type: string
    url: string | null
    repoFullName: string | null
  } | null
  events: ScanEvent[]
  integrity: {
    manifestChecksum: string | null
    urlExecution?: Record<string, unknown> | null
    coverage: Array<{
      scanner: string
      controlId: string
      status: string
      reason: string | null
      subject: string | null
      metadata: Record<string, unknown> | null
    }>
  }
  aiSecurity: {
    score: number | null
    methodology: string
    assessedCount: number
    totalControls: number
    evidenceQuality: Record<string, number> | null
    reason: string | null
    ai03: unknown
    triage: unknown
    computedAt: string
  } | null
}

interface ScanPollData {
  id: string
  workspaceId: string
  status: string
  goal: string
  mode: string
  triggerType: string
  startedAt: string | Date | null
  endedAt: string | Date | null
  summary: string | null
  errorCategory: string | null
  errorMessage: string | null
  llmRequestCount?: number | null
  llmInputTokens?: number | null
  llmCachedInputTokens?: number | null
  llmOutputTokens?: number | null
  createdAt: string | Date
  events?: Array<
    Omit<ScanEvent, "metadata" | "createdAt"> & { metadata?: unknown; createdAt: string | Date }
  >
  resultManifest?: { checksum?: string | null } | null
  coverageReceipts?: Array<{
    scanner: string
    controlId: string
    status: string
    reason?: string | null
    subject?: string | null
    metadata?: unknown
  }>
}

const INTERNAL_ACCOUNTING_EVENT_STAGES = new Set(["budget_cap", "llm_usage", "budget_exceeded"])

interface FindingItem {
  id: string
  title: string
  severity: string
  status: string
  cwe: string | null
  cvssScore: number | null
  summary: string | null
  verified: boolean
  verificationStatus: string
  verificationMethod: string | null
  verificationReason: string | null
  createdAt: string
}

const findingItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    severity: z.string(),
    status: z.string(),
    cwe: z.string().nullable(),
    cvssScore: z.number().nullable(),
    summary: z.string().nullable(),
    verified: z.boolean(),
    verificationStatus: z.string(),
    verificationMethod: z.string().nullable(),
    verificationReason: z.string().nullable(),
    createdAt: z.string().datetime().or(z.string()),
  })
  .passthrough()

const findingsPaginatedSchema = paginatedResponseSchema(findingItemSchema)

const scanPollEventSchema = z
  .object({
    id: z.string(),
    stage: z.string(),
    level: z.string(),
    message: z.string(),
    metadata: z.unknown().optional(),
    createdAt: z.string().datetime().or(z.string()).or(z.date()),
  })
  .passthrough()

const scanPollCoverageReceiptSchema = z
  .object({
    scanner: z.string(),
    controlId: z.string(),
    status: z.string(),
    reason: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough()

const scanPollDataSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    status: z.string(),
    goal: z.string(),
    mode: z.string(),
    triggerType: z.string(),
    startedAt: z.string().datetime().or(z.string()).or(z.date()).nullable(),
    endedAt: z.string().datetime().or(z.string()).or(z.date()).nullable(),
    summary: z.string().nullable(),
    errorCategory: z.string().nullable(),
    errorMessage: z.string().nullable(),
    llmRequestCount: z.number().nullable().optional(),
    llmInputTokens: z.number().nullable().optional(),
    llmCachedInputTokens: z.number().nullable().optional(),
    llmOutputTokens: z.number().nullable().optional(),
    createdAt: z.string().datetime().or(z.string()).or(z.date()),
    events: z.array(scanPollEventSchema).optional(),
    resultManifest: z
      .object({
        checksum: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    coverageReceipts: z.array(scanPollCoverageReceiptSchema).optional(),
  })
  .passthrough()

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
}

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

const EVENT_LEVEL_COLOR: Record<string, string> = {
  info: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
}

const SCANNER_LABELS: Record<string, string> = {
  engine: "Engine review",
  agent_config: "Agent configuration",
  sca: "Dependency scan",
  secrets: "Secret scan",
  url: "URL scan",
}

const ELAPSED_TIME_INTERVAL_MS = 1_000
const COMPLETION_NOTICE_DISMISS_MS = 6_000

/** Ticking elapsed time from a start timestamp, returning a formatted string. */
function useElapsedTime(startedAt: string | null): string {
  const [elapsed, setElapsed] = useState(() => formatDuration(startedAt, null))
  useEffect(() => {
    if (!startedAt) return
    const tick = () => setElapsed(formatDuration(startedAt, null))
    tick()
    const id = window.setInterval(tick, ELAPSED_TIME_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [startedAt])
  return elapsed
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "—"
  const startMs = new Date(start).getTime()
  const endMs = end ? new Date(end).getTime() : Date.now()
  const diffSec = Math.round((endMs - startMs) / 1000)
  if (diffSec < 60) return `${diffSec}s`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ${diffSec % 60}s`
  return `${Math.floor(diffSec / 3600)}h ${Math.floor((diffSec % 3600) / 60)}m`
}

function asIsoString(value: string | Date | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function asMetadata(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function ScanDetailClient({
  scan: initialScan,
  findings,
}: {
  scan: ScanData
  findings: FindingItem[]
}) {
  const [scan, setScan] = useState<ScanData>(initialScan)
  const [currentFindings, setCurrentFindings] = useState<FindingItem[]>(findings)
  const [expandedEvents, setExpandedEvents] = useState(false)
  const [expandedFindings, setExpandedFindings] = useState<Set<string>>(new Set())
  const [completionNotice, setCompletionNotice] = useState<{
    status: string
    message: string
  } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const isActive = isActiveScan(scan.status)
  const elapsedTime = useElapsedTime(isActive ? scan.startedAt : null)
  const presentation = getScanPresentation(scan.status)
  const etagRef = useRef<string | undefined>(undefined)
  const prevStatusRef = useRef(initialScan.status)

  // Announce the active→terminal transition. Polling swaps the in-progress view
  // for the stat grid silently otherwise, so users who looked away (or use a
  // screen reader) never learn the scan finished.
  useEffect(() => {
    const prevStatus = prevStatusRef.current
    prevStatusRef.current = scan.status
    if (!isActiveScan(prevStatus) || isActiveScan(scan.status)) return
    setCompletionNotice({
      status: scan.status,
      message:
        scan.status === "COMPLETED"
          ? // Deliberately no count: the terminal fetch is capped at one page, so
            // a scan with more findings than that would be announced with the
            // page size as if it were the total.
            "Scan completed — findings are ready to review"
          : getScanPresentation(scan.status).headline,
    })
  }, [scan.status])

  // Auto-dismiss the completion banner after 6s; the outcome stays visible in
  // the status badge and stat grid.
  useEffect(() => {
    if (!completionNotice) return
    const id = window.setTimeout(() => setCompletionNotice(null), COMPLETION_NOTICE_DISMISS_MS)
    return () => window.clearTimeout(id)
  }, [completionNotice])

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const { data, etag } = await apiGetConditional<ScanPollData>(
          `/api/scans/${scan.id}?workspaceId=${encodeURIComponent(scan.workspaceId)}`,
          { signal, etag: etagRef.current, schema: scanPollDataSchema }
        )
        etagRef.current = etag
        if (!data || signal.aborted) return

        const updated = data
        const nextScan: ScanData = {
          id: updated.id,
          workspaceId: updated.workspaceId,
          status: updated.status,
          goal: updated.goal,
          mode: updated.mode,
          triggerType: updated.triggerType,
          target: scan.target,
          startedAt: asIsoString(updated.startedAt),
          endedAt: asIsoString(updated.endedAt),
          summary: updated.summary,
          errorCategory: updated.errorCategory,
          errorMessage: updated.errorMessage,
          createdAt: asIsoString(updated.createdAt)!,
          events: (updated.events ?? []).map((event) => ({
            id: event.id,
            stage: event.stage,
            level: event.level,
            message: event.message,
            metadata: asMetadata(event.metadata),
            createdAt: asIsoString(event.createdAt)!,
          })),
          integrity: {
            ...scan.integrity,
            manifestChecksum: updated.resultManifest?.checksum ?? null,
            urlExecution:
              ((updated.resultManifest as Record<string, unknown> | undefined)?.urlExecution as
                Record<string, unknown> | undefined | null) ?? scan.integrity.urlExecution,
            coverage: (updated.coverageReceipts ?? []).map((receipt) => ({
              scanner: receipt.scanner,
              controlId: receipt.controlId,
              status: receipt.status,
              reason: receipt.reason ?? null,
              subject: receipt.subject ?? null,
              metadata: asMetadata(receipt.metadata),
            })),
          },
          aiSecurity: scan.aiSecurity,
        }
        let refreshedFindings: FindingItem[] | null = null
        if (
          ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"].includes(
            updated.status
          )
        ) {
          // A single bounded fetch (limit 100) is sufficient for the scan detail
          // view. Very large finding sets are navigated via the findings page.
          const page = await apiGetPaginated<FindingItem>(
            "/api/findings",
            { workspaceId: updated.workspaceId, scanId: scan.id, limit: "100" },
            { signal, schema: findingsPaginatedSchema }
          )
          refreshedFindings = page.items
        }
        if (!signal.aborted) {
          // Commit the terminal status and its finding list together. If the
          // finding request fails transiently, the active poll remains alive
          // and retries instead of rendering a false zero until page reload.
          setScan(nextScan)
          if (refreshedFindings) setCurrentFindings(refreshedFindings)
        }
      } catch {
        // Network errors during polling are non-fatal — keep showing stale data
      }
    },
    [scan.aiSecurity, scan.id, scan.target, scan.workspaceId, scan.integrity]
  )

  useEffect(() => {
    if (!isActive) return
    const controller = new AbortController()
    let timeoutId: number | undefined
    let isAborted = false

    const nextInterval = (elapsedMs: number): number => {
      if (elapsedMs < 60_000) return 5_000
      if (elapsedMs < 5 * 60_000) return 10_000
      return 60_000
    }

    const poll = async () => {
      if (document.hidden) {
        timeoutId = window.setTimeout(poll, 1000)
        return
      }
      await refresh(controller.signal)
      if (isAborted) return
      const startedAtMs = scan.startedAt ? new Date(scan.startedAt).getTime() : Date.now()
      const elapsed = Date.now() - startedAtMs
      timeoutId = window.setTimeout(poll, nextInterval(elapsed))
    }

    timeoutId = window.setTimeout(poll, 5_000)

    const onVisibility = () => {
      if (!document.hidden && isActive && !isAborted) {
        window.clearTimeout(timeoutId)
        timeoutId = window.setTimeout(poll, 0)
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      isAborted = true
      controller.abort()
      document.removeEventListener("visibilitychange", onVisibility)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [isActive, refresh, scan.startedAt])

  async function handleManualRefresh() {
    setRefreshing(true)
    etagRef.current = undefined
    const controller = new AbortController()
    try {
      await refresh(controller.signal)
    } finally {
      setRefreshing(false)
    }
  }

  const sortedFindings = [...currentFindings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
  )

  const severityCounts = currentFindings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>
  )

  const displayEvents = scan.events.filter(
    (event) => !INTERNAL_ACCOUNTING_EVENT_STAGES.has(event.stage)
  )
  const visibleEvents = expandedEvents ? displayEvents : displayEvents.slice(-10)
  const coverageWarnings = getScannerCoverageWarnings(scan.events)
  const hasLimitedCoverage = coverageWarnings.length > 0
  const familyCoverage = scan.integrity.coverage.filter(
    (receipt) => !receipt.controlId.startsWith("vibe-")
  )
  const controlCoverage = scan.integrity.coverage.filter((receipt) =>
    receipt.controlId.startsWith("vibe-")
  )
  const incompleteCoverage = familyCoverage.filter(
    (receipt) => !["COMPLETED", "NOT_APPLICABLE"].includes(receipt.status)
  )
  const controlOutcomeCounts = controlCoverage.reduce(
    (counts, receipt) => {
      const outcome =
        typeof receipt.metadata?.outcome === "string" ? receipt.metadata.outcome : receipt.status
      counts[outcome] = (counts[outcome] ?? 0) + 1
      return counts
    },
    {} as Record<string, number>
  )
  const reviewProfile = getScanReviewProfile(scan.events)
  const topFinding = sortedFindings[0]
  function toggleFinding(id: string) {
    setExpandedFindings((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div>
      {/* Sole announcer for the scan-completion message. Always mounted, because
          a live region inserted at the same moment as its content is announced
          unreliably. The visible banner below is therefore presentational only —
          giving it live semantics too would double-announce. */}
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {completionNotice?.message}
      </div>
      <div className="mb-6">
        <Link
          href="/dashboard/scans"
          className="text-muted-foreground hover:text-foreground mb-3 inline-flex min-h-11 items-center gap-1.5 px-1 text-sm"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to scans
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight">
              <Radar className="h-6 w-6" aria-hidden="true" />
              {presentation.headline}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {getScanGoalLabel(scan.goal)} · {getScanModeLabel(scan.mode)} ·{" "}
              {getScanTriggerLabel(scan.triggerType)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleManualRefresh()}
              disabled={refreshing}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {isActive && (
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-500" />
                </span>
                Live
              </span>
            )}
            <Badge variant={presentation.badgeVariant} className="text-sm">
              {presentation.label}
            </Badge>
          </div>
        </div>
      </div>

      {/* In-progress view: replaces the stat-heavy completed layout while the scan is active */}
      {isActive && (
        <div className="mb-6">
          <ScanInProgress
            status={scan.status}
            mode={scan.mode}
            startedAt={scan.startedAt}
            elapsedTime={elapsedTime}
            events={displayEvents}
            findingsCount={currentFindings.length}
            onRefresh={() => void handleManualRefresh()}
            refreshing={refreshing}
          />
        </div>
      )}

      {/* Completed / terminal layout — rendered only once the scan is no longer active */}
      {!isActive && (
        <>
          {completionNotice && (
            // Presentational only — the always-mounted sr-only live region above
            // owns the announcement, so no role="status" here (that would make
            // screen readers read the completion twice).
            <div
              className={`mb-6 flex items-center gap-2 rounded-md border p-3 text-sm ${
                completionNotice.status === "COMPLETED"
                  ? "border-primary/30 bg-primary/5"
                  : ["FAILED", "TIMED_OUT"].includes(completionNotice.status)
                    ? "border-destructive/50 bg-destructive/10"
                    : "border-amber-500/50 bg-amber-500/10"
              }`}
            >
              {completionNotice.status === "COMPLETED" ? (
                <CheckCircle2 className="text-primary h-4 w-4 shrink-0" aria-hidden="true" />
              ) : ["FAILED", "TIMED_OUT"].includes(completionNotice.status) ? (
                <XCircle className="text-destructive h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 font-medium">{completionNotice.message}</span>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
                onClick={() => setCompletionNotice(null)}
              >
                Dismiss
              </Button>
            </div>
          )}
          <div className="bg-border mb-6 grid gap-px border sm:grid-cols-2 lg:grid-cols-6">
            <Card className="border-0 p-4 shadow-none">
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4" aria-hidden="true" />
                Duration
              </div>
              <p className="mt-1 text-lg font-semibold">
                {formatDuration(scan.startedAt, scan.endedAt)}
              </p>
            </Card>
            <Card className="border-0 p-4 shadow-none">
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                Findings reported
              </div>
              <p className="mt-1 text-lg font-semibold">{currentFindings.length}</p>
            </Card>
            <Card className="border-0 p-4 shadow-none">
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Independently verified
              </div>
              <p className="mt-1 text-lg font-semibold">
                {currentFindings.filter((f) => f.verified).length}
              </p>
            </Card>
            <Card className="border-0 p-4 shadow-none">
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                Status
              </div>
              <p className="mt-1 text-lg font-semibold">{presentation.label}</p>
            </Card>
            <Card className="border-0 p-4 shadow-none">
              <div
                className="text-muted-foreground flex items-center gap-2 text-sm"
                title="The scan result is sealed into a verifiable manifest"
              >
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Tamper-evident record
              </div>
              <p className="mt-1 text-lg font-semibold">
                {scan.integrity.manifestChecksum ? "Sealed" : isActive ? "Sealing…" : "Not sealed"}
              </p>
            </Card>
            <AiSecurityScoreCard data={scan.aiSecurity} />
          </div>

          {scan.target && (
            <Card className="mb-6 p-4">
              <h2 className="mb-2 text-sm font-semibold">Target</h2>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium">{scan.target.name}</span>
                <Badge variant="muted">{scan.target.type}</Badge>
                {scan.target.repoFullName && (
                  <span className="text-muted-foreground">{scan.target.repoFullName}</span>
                )}
                {scan.target.url && (
                  <a
                    href={scan.target.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    {scan.target.url}
                  </a>
                )}
              </div>
            </Card>
          )}

          {presentation.assuranceAvailable && (
            <Card className="border-primary/30 bg-primary/5 mb-6 p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                    Next step
                  </p>
                  <h2 className="mt-1 text-lg font-semibold">
                    {topFinding
                      ? "Review the highest-priority finding"
                      : "Create an assurance report"}
                  </h2>
                  <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
                    {topFinding
                      ? "Understand the evidence, record a fix proposal, then queue a fresh retest."
                      : "Package this completed scan and its retained scope into an immutable report."}
                  </p>
                </div>
                <Link
                  href={
                    topFinding
                      ? `/dashboard/findings?finding=${encodeURIComponent(topFinding.id)}`
                      : `/dashboard/findings?tab=reports&scanId=${encodeURIComponent(scan.id)}`
                  }
                  className={buttonVariants({ className: "shrink-0" })}
                >
                  {topFinding ? "Review finding" : "Generate report"}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
            </Card>
          )}

          {presentation.showFailureDetails && (
            <div
              role="alert"
              className="border-destructive/50 bg-destructive/10 mb-6 border-l-2 p-4 text-sm"
            >
              <p className="font-semibold">{presentation.headline}</p>
              <p className="text-foreground/80 mt-1">{presentation.description}</p>
              {scan.errorMessage && (
                <details className="text-foreground mt-3">
                  <summary className="cursor-pointer font-medium">Failure details</summary>
                  <p className="mt-2 wrap-break-word">
                    {scan.errorCategory ? `${scan.errorCategory}: ` : ""}
                    {scan.status === "STOPPED_BUDGET" || scan.errorCategory === "BUDGET_EXCEEDED"
                      ? "The protected run limit was reached."
                      : scan.errorMessage}
                  </p>
                </details>
              )}
            </div>
          )}

          {scan.summary && presentation.assuranceAvailable && (
            <Card className="mb-6 p-4">
              <h2 className="mb-1 text-sm font-semibold">Engine summary</h2>
              <p className="text-muted-foreground text-sm">{scan.summary}</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Deterministic scanner findings are included in the total and the findings list
                below.
              </p>
            </Card>
          )}

          {scan.integrity.urlExecution && (
            <Card
              className="mb-6 p-4"
              role="region"
              aria-labelledby="url-execution-heading"
              aria-describedby="url-execution-limitations"
            >
              <h2 id="url-execution-heading" className="font-semibold">
                URL execution scope
              </h2>
              <p className="text-muted-foreground mt-1 text-sm" id="url-execution-limitations">
                {renderUrlExecutionLine(scan.integrity.urlExecution)}
              </p>
              {Array.isArray(scan.integrity.urlExecution.issueCodes) &&
                scan.integrity.urlExecution.issueCodes.length > 0 && (
                  <p className="mt-2 text-sm text-amber-600" role="status" aria-live="polite">
                    Coverage limited: {scan.integrity.urlExecution.issueCodes.join(", ")}
                  </p>
                )}
              <p className="text-muted-foreground mt-2 text-xs">
                This public, non-mutating review did not authenticate or validate exploitability.
              </p>
            </Card>
          )}

          {hasLimitedCoverage && (
            <section
              aria-labelledby="coverage-warning-heading"
              className="mb-6 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4"
            >
              <div className="flex items-start gap-3">
                <ShieldAlert
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <h2 id="coverage-warning-heading" className="font-semibold">
                    Some scanner coverage was limited
                  </h2>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Results are available, but the checks below could not fully evaluate every
                    supported input. Review them before treating this scan as a complete clean
                    result.
                  </p>
                  <ul className="mt-3 space-y-2 text-sm">
                    {coverageWarnings.map((warning, index) => (
                      <li
                        key={`${warning.scanner}-${warning.status}-${warning.subject ?? ""}-${index}`}
                        className="bg-background/40 rounded-md border border-amber-500/30 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {SCANNER_LABELS[warning.scanner] ?? warning.scanner}
                          </span>
                          <Badge variant="warning">{warning.status}</Badge>
                          {warning.subject && (
                            <span className="text-muted-foreground wrap-break-word">
                              {warning.subject}
                            </span>
                          )}
                        </div>
                        <p className="text-muted-foreground mt-1">{warning.reason}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          )}

          {(scan.integrity.coverage.length > 0 || reviewProfile.model) && (
            <Card className="mb-6 p-4" aria-labelledby="review-profile-heading">
              <div>
                <h2 id="review-profile-heading" className="font-semibold">
                  Review details
                </h2>
                <p className="text-muted-foreground mt-1 text-sm">
                  AI assistance can support analysis. Retained scanner receipts and independent
                  verification determine the proof state shown by LyraShield.
                </p>
              </div>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-md border p-3">
                  <dt className="text-muted-foreground text-xs">Analysis path</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {reviewProfile.model ? "AI-assisted review" : "Deterministic scanners"}
                  </dd>
                </div>
                <div className="rounded-md border p-3">
                  <dt className="text-muted-foreground text-xs">Model</dt>
                  <dd className="mt-1 text-sm font-medium wrap-break-word">
                    {reviewProfile.model ?? "Not invoked"}
                  </dd>
                  {reviewProfile.reasoningEffort && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {reviewProfile.reasoningEffort} reasoning
                    </p>
                  )}
                </div>
                <div className="rounded-md border p-3">
                  <dt className="text-muted-foreground text-xs">Vibe Security 50</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {controlCoverage.length > 0
                      ? `${controlCoverage.length} controls recorded`
                      : "Pending"}
                  </dd>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {controlCoverage.length === 0
                      ? "No checklist receipt recorded"
                      : `${controlOutcomeCounts.DETECTED ?? 0} with findings · ${controlOutcomeCounts.EVIDENCE_REQUIRED ?? 0} need evidence`}
                  </p>
                </div>
              </dl>
            </Card>
          )}

          {scan.integrity.coverage.length > 0 && (
            <Card className="mb-6 p-4" aria-labelledby="integrity-heading">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 id="integrity-heading" className="font-semibold">
                    Coverage and proof state
                  </h2>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Detection and verification are separate. A finding is verified only after an
                    independent verification receipt is retained.
                  </p>
                </div>
                <Badge variant={incompleteCoverage.length > 0 ? "warning" : "success"}>
                  {incompleteCoverage.length > 0 ? "Coverage limited" : "Coverage recorded"}
                </Badge>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {familyCoverage.map((receipt) => (
                  <div key={receipt.controlId} className="rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {SCANNER_LABELS[receipt.scanner] ?? receipt.scanner}
                      </span>
                      <Badge
                        variant={
                          receipt.status === "COMPLETED"
                            ? "success"
                            : receipt.status === "NOT_APPLICABLE"
                              ? "muted"
                              : "warning"
                        }
                      >
                        {receipt.status.replaceAll("_", " ")}
                      </Badge>
                    </div>
                    {receipt.reason && (
                      <p className="text-muted-foreground mt-1 text-xs">{receipt.reason}</p>
                    )}
                  </div>
                ))}
              </div>
              {controlCoverage.length > 0 && (
                <div className="mt-5 border-t pt-5">
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                    {[
                      ["Findings mapped", controlOutcomeCounts.DETECTED ?? 0, "danger"],
                      ["No finding returned", controlOutcomeCounts.NO_FINDING ?? 0, "muted"],
                      ["Evidence required", controlOutcomeCounts.EVIDENCE_REQUIRED ?? 0, "warning"],
                      ["Inconclusive", controlOutcomeCounts.INCONCLUSIVE ?? 0, "warning"],
                      ["Not applicable", controlOutcomeCounts.NOT_APPLICABLE ?? 0, "muted"],
                    ].map(([label, count, variant]) => (
                      <div key={String(label)} className="rounded-md border p-3">
                        <p className="text-muted-foreground text-xs">{label}</p>
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <span className="text-lg font-semibold">{count}</span>
                          <Badge variant={variant as "danger" | "success" | "warning" | "muted"}>
                            {count}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-muted-foreground mt-3 text-xs">
                    “No finding returned” means an applicable scanner completed without reporting
                    this issue. It is not an independent verification or a security guarantee.
                  </p>
                  <p className="text-muted-foreground mt-2 text-xs">
                    “Inconclusive” is expected for many engine-led controls where the run completed
                    but no explicit control mapping was returned. It indicates a coverage gap by
                    design, not a failed scan.
                  </p>
                  <details className="mt-4 rounded-md border">
                    <summary className="hover:bg-muted/50 flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
                      Review all 50 control receipts
                      <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
                    </summary>
                    <div className="divide-y border-t">
                      {controlCoverage.map((receipt) => {
                        const rank =
                          typeof receipt.metadata?.rank === "number" ? receipt.metadata.rank : null
                        const title =
                          typeof receipt.metadata?.title === "string"
                            ? receipt.metadata.title
                            : receipt.controlId
                        const outcome =
                          typeof receipt.metadata?.outcome === "string"
                            ? receipt.metadata.outcome
                            : receipt.status
                        const badgeVariant =
                          outcome === "DETECTED"
                            ? "danger"
                            : outcome === "NO_FINDING"
                              ? "muted"
                              : outcome === "NOT_APPLICABLE"
                                ? "muted"
                                : "warning"
                        return (
                          <div
                            key={receipt.controlId}
                            className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium">
                                {rank ? `${rank}. ` : ""}
                                {title}
                              </p>
                              {receipt.reason && (
                                <p className="text-muted-foreground mt-1 text-xs">
                                  {receipt.reason}
                                </p>
                              )}
                            </div>
                            <Badge variant={badgeVariant}>{outcome.replaceAll("_", " ")}</Badge>
                          </div>
                        )
                      })}
                    </div>
                  </details>
                </div>
              )}
              {scan.integrity.manifestChecksum && (
                <p className="text-muted-foreground mt-3 font-mono text-xs">
                  Manifest SHA-256: {scan.integrity.manifestChecksum}
                </p>
              )}
            </Card>
          )}

          {currentFindings.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-3 text-lg font-semibold">Findings ({currentFindings.length})</h2>
              {Object.entries(severityCounts)
                .sort(([a], [b]) => (SEVERITY_ORDER[a] ?? 99) - (SEVERITY_ORDER[b] ?? 99))
                .map(([sev, count]) => {
                  const Icon = SEVERITY_ICON[sev] ?? Shield
                  return (
                    <span
                      key={sev}
                      className={`mr-3 inline-flex items-center gap-1 text-sm font-medium ${SEVERITY_COLOR[sev] ?? ""}`}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                      {count} {sev}
                    </span>
                  )
                })}
              <div className="mt-3 space-y-2">
                {sortedFindings.map((finding) => {
                  const Icon = SEVERITY_ICON[finding.severity] ?? Shield
                  const isExpanded = expandedFindings.has(finding.id)
                  return (
                    <Card key={finding.id} className="p-4">
                      <button
                        type="button"
                        onClick={() => toggleFinding(finding.id)}
                        className="flex w-full items-start justify-between gap-3 text-left"
                        aria-expanded={isExpanded}
                        aria-controls={`finding-${finding.id}-detail`}
                      >
                        <div className="flex items-start gap-3">
                          <Icon
                            className={`mt-0.5 h-5 w-5 shrink-0 ${SEVERITY_COLOR[finding.severity] ?? ""}`}
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <p className="font-medium">{finding.title}</p>
                            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-xs">
                              <Badge variant="muted">{severityLabel(finding.severity)}</Badge>
                              {finding.cwe && <span>CWE: {finding.cwe}</span>}
                              {finding.cvssScore !== null && <span>CVSS: {finding.cvssScore}</span>}
                              {finding.verified && (
                                <span className="text-emerald-600">Verified</span>
                              )}
                              {!finding.verified && (
                                <span>{finding.verificationStatus.replaceAll("_", " ")}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        {isExpanded ? (
                          <ChevronDown
                            className="text-muted-foreground h-5 w-5 shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <ChevronRight
                            className="text-muted-foreground h-5 w-5 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                      {isExpanded && (finding.summary || finding.verificationReason) && (
                        <div
                          id={`finding-${finding.id}-detail`}
                          className="text-muted-foreground mt-3 border-t pt-3 text-sm"
                        >
                          {finding.summary && <p>{finding.summary}</p>}
                          {finding.verificationReason && (
                            <p className="mt-2 text-xs">{finding.verificationReason}</p>
                          )}
                        </div>
                      )}
                    </Card>
                  )
                })}
              </div>
            </div>
          )}

          {currentFindings.length === 0 && !isActive && presentation.assuranceAvailable && (
            <EmptyState
              icon={ShieldCheck}
              title="No findings were reported"
              description={
                hasLimitedCoverage
                  ? "Some scanner coverage was limited. Review the coverage notice above before treating this as a clean result."
                  : scan.status === "COMPLETED"
                    ? "No findings were reported within this scan's completed coverage. Review the retained scope before relying on the result."
                    : "No findings were recorded before this scan ended."
              }
              action={null}
            />
          )}
        </>
      )}

      <details className="group">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 border-y py-3 text-sm font-semibold marker:hidden">
          <span>Technical details</span>
          <span className="text-muted-foreground text-xs font-normal">
            {displayEvents.length} event{displayEvents.length === 1 ? "" : "s"}
          </span>
        </summary>
        <div className="pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Scan events</h2>
            {displayEvents.length > 10 && (
              <Button variant="ghost" size="sm" onClick={() => setExpandedEvents(!expandedEvents)}>
                {expandedEvents ? "Show last 10" : `Show all ${displayEvents.length}`}
              </Button>
            )}
          </div>
          {displayEvents.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No events"
              description="No scan events have been recorded yet."
              action={null}
            />
          ) : (
            <Card className="p-4">
              <div className="divide-border space-y-0 divide-y">
                {visibleEvents.map((event, idx) => (
                  <div key={event.id} className="flex items-start gap-3 py-2 text-sm">
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {formatTime(event.createdAt)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span
                        className={`font-mono text-xs ${EVENT_LEVEL_COLOR[event.level] ?? "text-muted-foreground"}`}
                      >
                        [{event.stage}]
                      </span>
                      <span className="ml-2 wrap-break-word">{event.message}</span>
                    </div>
                    {idx === 0 && !expandedEvents && displayEvents.length > 10 && (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        +{displayEvents.length - 10} earlier
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </details>
    </div>
  )
}

function renderUrlExecutionLine(execution: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    WEB_APP_SAFE: "Surface Review",
    WEB_APP_STANDARD: "Expanded Surface Review",
    WEB_APP_DEEP: "Behavioral Surface Review",
    API_SAFE: "Endpoint Review",
    API_STANDARD: "Contract Review",
    API_DEEP: "Contract Behavior Review",
  }
  const name = labels[String(execution.profile)] ?? String(execution.profile ?? "URL scan")
  const methods = Array.isArray(execution.methods) ? execution.methods.join(", ") : ""
  const parts: string[] = []
  if (typeof execution.documentCount === "number" && execution.documentCount > 0) {
    parts.push(`${execution.documentCount} pages`)
  }
  if (typeof execution.assetCount === "number" && execution.assetCount > 0) {
    parts.push(`${execution.assetCount} assets`)
  }
  if (typeof execution.operationCount === "number" && execution.operationCount > 0) {
    parts.push(`${execution.operationCount} operations`)
  }
  if (typeof execution.methodProbeCount === "number" && execution.methodProbeCount > 0) {
    parts.push(`${execution.methodProbeCount} method probes`)
  }
  if (typeof execution.originProbeCount === "number" && execution.originProbeCount > 0) {
    parts.push(`${execution.originProbeCount} origin probes`)
  }
  const scope = parts.length > 0 ? ` · ${parts.join(" · ")}` : ""
  return `${name}${scope} · ${methods}`
}
