"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowLeft,
  ArrowRight,
  Radar,
  ShieldCheck,
  ShieldAlert,
  Shield,
  Clock,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react"
import { Card, Badge, Button, EmptyState, buttonVariants } from "@lyrashield/ui"
import { formatTime, formatDateTime } from "@/lib/date-format"
import { getScannerCoverageWarnings } from "@/lib/scan-coverage"
import { getScanPresentation, isActiveScan } from "@/lib/scan-presentation"
import { getScanReviewProfile } from "@/lib/scan-review-profile"
import { findingDetailItemsPaginatedSchema, scanPollDataSchema } from "@/lib/api-schemas"
import { apiGetConditional, apiGetPaginated } from "@/lib/api-client"
import {
  getScanGoalLabel,
  getScanModeLabel,
  getScanTriggerLabel,
  getVerificationStatusLabel,
} from "@/lib/enum-labels"
import { ScanInProgress } from "./scan-in-progress"
import { AiSecurityScoreCard } from "./ai-score-card"
import { severityLabel, humanizeToken } from "@/lib/labels"
import { track } from "@/lib/analytics"
import { safeApiErrorMessage } from "@/components/api-error-card"
import { scanRecoveryHref } from "../scans-client.utils"
import { ScorecardControls } from "../../targets/[id]/scorecard-controls"
import type { CleanResultScorecard, FindingItem, ScanData, ScanPollData } from "./scan-detail-types"
import {
  EVENT_LEVEL_COLOR,
  INTERNAL_ACCOUNTING_EVENT_STAGES,
  SCANNER_LABELS,
  SEVERITY_COLOR,
  SEVERITY_ICON,
  SEVERITY_ORDER,
} from "./scan-detail-presentation"
import {
  asIsoString,
  asMetadata,
  COMPLETION_NOTICE_DISMISS_MS,
  formatDuration,
  mergeEvents,
  useElapsedTime,
} from "./scan-detail-utils"

export function ScanDetailClient({
  scan: initialScan,
  findings,
  scorecard,
}: {
  scan: ScanData
  findings: FindingItem[]
  scorecard: CleanResultScorecard | null
}) {
  const router = useRouter()
  const [scan, setScan] = useState<ScanData>(initialScan)
  const [currentFindings, setCurrentFindings] = useState<FindingItem[]>(findings)
  const [expandedEvents, setExpandedEvents] = useState(false)
  const [expandedFindings, setExpandedFindings] = useState<Set<string>>(new Set())
  const [completionNotice, setCompletionNotice] = useState<{
    status: string
    message: string
  } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState(false)
  const isActive = isActiveScan(scan.status)
  const elapsedTime = useElapsedTime(isActive ? scan.startedAt : null)
  const presentation = getScanPresentation(scan.status, {
    errorCategory: scan.errorCategory,
    errorMessage: scan.errorMessage,
  })
  const etagRef = useRef<string | undefined>(undefined)
  const activeRequestRef = useRef<{ controller: AbortController; promise: Promise<void> } | null>(
    null
  )
  const prevStatusRef = useRef(initialScan.status)
  const scanRef = useRef(scan)
  useEffect(() => {
    scanRef.current = scan
  }, [scan])
  // Incremental event polling cursor: the id of the newest event already held
  // client-side. Each poll sends `eventsAfter` so the server returns only the
  // tail. A ref (not state) so the in-flight poll callback always reads the
  // latest cursor without re-render churn; it only advances after a successful
  // merge, so a failed or aborted poll re-delivers the same tail next tick.
  const eventCursorRef = useRef<string | null>(initialScan.events.at(-1)?.id ?? null)

  // Results landing: opening an already-terminal scan is a results view.
  // Status only — no finding detail, severity, or target coordinates.
  useEffect(() => {
    if (isActiveScan(initialScan.status)) return
    track("results_viewed", {
      status: initialScan.status,
      had_findings: findings.length > 0,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Announce the active→terminal transition. Polling swaps the in-progress view
  // for the stat grid silently otherwise, so users who looked away (or use a
  // screen reader) never learn the scan finished.
  useEffect(() => {
    const prevStatus = prevStatusRef.current
    prevStatusRef.current = scan.status
    if (!isActiveScan(prevStatus) || isActiveScan(scan.status)) return
    track("review_completed", { status: scan.status })
    setCompletionNotice({
      status: scan.status,
      message:
        scan.status === "COMPLETED"
          ? // Deliberately no count: the terminal fetch is capped at one page, so
            // a scan with more findings than that would be announced with the
            // page size as if it were the total.
            "Scan completed — findings are ready to review"
          : getScanPresentation(scan.status, {
              errorCategory: scan.errorCategory,
              errorMessage: scan.errorMessage,
            }).headline,
    })
  }, [scan.errorCategory, scan.errorMessage, scan.status])

  // A successful commit re-derives the cursor from the merged list (single
  // source of truth), so a failed, aborted, or validation-rejected poll never
  // advances it and the next tick re-delivers the same tail.
  useEffect(() => {
    eventCursorRef.current = scan.events.at(-1)?.id ?? null
  }, [scan])

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
        // Incremental polling: once a cursor exists, ask only for events after
        // it. The first tick (or a full-window fallback) repopulates the whole
        // list; manual refresh clears the cursor below to force that path.
        const eventCursor = eventCursorRef.current
        const cursorParam = eventCursor ? `&eventsAfter=${encodeURIComponent(eventCursor)}` : ""
        const { data, etag, status } = await apiGetConditional<ScanPollData>(
          `/api/scans/${scan.id}?workspaceId=${encodeURIComponent(scan.workspaceId)}${cursorParam}`,
          { signal, etag: etagRef.current, schema: scanPollDataSchema }
        )
        if (signal.aborted) return
        etagRef.current = status === 304 ? (etag ?? etagRef.current) : etag
        setRefreshError(false)
        if (!data) return

        const updated = data
        const nextScan: ScanData = {
          id: updated.id,
          workspaceId: updated.workspaceId,
          status: updated.status,
          goal: updated.goal,
          mode: updated.mode,
          triggerType: updated.triggerType,
          target: scanRef.current.target,
          startedAt: asIsoString(updated.startedAt),
          endedAt: asIsoString(updated.endedAt),
          summary: updated.summary,
          errorCategory: updated.errorCategory,
          errorMessage: updated.errorMessage,
          createdAt: asIsoString(updated.createdAt)!,
          // The immutable plan is SSR-only; the poll never carries it.
          executionPlan: scanRef.current.executionPlan,
          events: mergeEvents(
            scanRef.current.events,
            (updated.events ?? []).map((event) => ({
              id: event.id,
              stage: event.stage,
              level: event.level,
              message: event.message,
              metadata: asMetadata(event.metadata),
              createdAt: asIsoString(event.createdAt)!,
            })),
            // A tail page is only merged when the server echoes that the
            // cursor sent on this very request was applied; anything else is a
            // full replacement.
            updated.eventsCursorApplied === eventCursor && eventCursor !== null
          ),
          integrity: {
            ...scanRef.current.integrity,
            manifestChecksum: updated.resultManifest?.checksum ?? null,
            // urlExecution comes from the server-rendered manifest detail;
            // the polling payload carries the checksum only.
            urlExecution: scanRef.current.integrity.urlExecution,
            coverage: (updated.coverageReceipts ?? []).map((receipt) => ({
              scanner: receipt.scanner,
              controlId: receipt.controlId,
              status: receipt.status,
              reason: receipt.reason ?? null,
              subject: receipt.subject ?? null,
              metadata: asMetadata(receipt.metadata),
            })),
          },
          aiSecurity: scanRef.current.aiSecurity,
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
            { signal, schema: findingDetailItemsPaginatedSchema }
          )
          refreshedFindings = page.items
        }
        if (!signal.aborted) {
          // Commit the terminal status and its finding list together. If the
          // finding request fails transiently, the active poll remains alive
          // and retries instead of rendering a false zero until page reload.
          setScan(nextScan)
          if (refreshedFindings) setCurrentFindings(refreshedFindings)
          if (updated.status === "COMPLETED" && refreshedFindings?.length === 0) {
            router.refresh()
          }
        }
      } catch {
        if (!signal.aborted) setRefreshError(true)
      }
    },
    [router, scan.id, scan.workspaceId]
  )

  const runRefresh = useCallback(
    (manual = false) => {
      if (manual) activeRequestRef.current?.controller.abort()
      else if (activeRequestRef.current) return activeRequestRef.current.promise

      const controller = new AbortController()
      const promise = refresh(controller.signal).finally(() => {
        if (activeRequestRef.current?.controller === controller) activeRequestRef.current = null
      })
      activeRequestRef.current = { controller, promise }
      return promise
    },
    [refresh]
  )

  useEffect(() => {
    if (!isActive) return
    // SSR safety: the polling loop touches `document`; never assume a DOM.
    if (typeof document === "undefined") return
    let timeoutId: number | undefined
    let isAborted = false
    let inFlight = false
    let refreshOnVisible = false

    const nextInterval = (elapsedMs: number): number => {
      if (elapsedMs < 60_000) return 5_000
      if (elapsedMs < 5 * 60_000) return 10_000
      return 60_000
    }

    // Battery/network: while the tab is hidden the poll loop suspends entirely
    // — no timer spin and no fetches. `onVisibility` below resumes it with one
    // immediate refetch when the tab becomes visible, so state catches up right
    // away instead of waiting out the (up to 60s) backoff interval.
    const schedule = (delayMs: number) => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      timeoutId = undefined
      if (!isAborted && !document.hidden) timeoutId = window.setTimeout(poll, delayMs)
    }

    const poll = async () => {
      timeoutId = undefined
      if (isAborted || document.hidden || inFlight) return
      inFlight = true
      try {
        await runRefresh()
      } finally {
        inFlight = false
        if (!isAborted && !document.hidden) {
          const startedAtMs = scan.startedAt ? new Date(scan.startedAt).getTime() : Date.now()
          const delay = refreshOnVisible ? 0 : nextInterval(Date.now() - startedAtMs)
          refreshOnVisible = false
          schedule(delay)
        }
      }
    }

    schedule(5_000)

    const onVisibility = () => {
      if (document.hidden) {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
        timeoutId = undefined
        refreshOnVisible = false
      } else if (isActive && !isAborted) {
        if (inFlight) refreshOnVisible = true
        else schedule(0)
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      isAborted = true
      activeRequestRef.current?.controller.abort()
      document.removeEventListener("visibilitychange", onVisibility)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [isActive, runRefresh, scan.startedAt])

  useEffect(() => () => activeRequestRef.current?.controller.abort(), [])

  async function handleManualRefresh() {
    setRefreshing(true)
    etagRef.current = undefined
    // Force a full-window refetch: manual refresh is the user's "prove it"
    // action, so re-fetch every event instead of trusting the incremental tail.
    eventCursorRef.current = null
    try {
      await runRefresh(true)
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
  // run.json 1.1 scoped coverage (engine-scope:*/engine-gap:*) is a model
  // self-report carried for evidence — it never joins the deterministic
  // scanner-family rows or the vibe control rows.
  const isEngineDeclaredReceipt = (controlId: string) =>
    controlId.startsWith("engine-scope:") || controlId.startsWith("engine-gap:")
  const familyCoverage = scan.integrity.coverage.filter(
    (receipt) =>
      !receipt.controlId.startsWith("vibe-") && !isEngineDeclaredReceipt(receipt.controlId)
  )
  const controlCoverage = scan.integrity.coverage.filter((receipt) =>
    receipt.controlId.startsWith("vibe-")
  )
  const relayAuditEvent = [...scan.events].reverse().find((e) => e.stage === "relay_audit")
  const relayScopeEvent = [...scan.events].reverse().find((e) => e.stage === "relay_scope")
  const relayStats =
    relayAuditEvent || relayScopeEvent
      ? {
          requests:
            typeof relayAuditEvent?.metadata === "object" &&
            relayAuditEvent.metadata &&
            typeof (relayAuditEvent.metadata as Record<string, unknown>).entries === "number"
              ? ((relayAuditEvent.metadata as Record<string, unknown>).entries as number)
              : null,
          hosts:
            typeof relayScopeEvent?.metadata === "object" &&
            relayScopeEvent.metadata &&
            Array.isArray((relayScopeEvent.metadata as Record<string, unknown>).hosts)
              ? ((relayScopeEvent.metadata as Record<string, unknown>).hosts as unknown[]).filter(
                  (h): h is string => typeof h === "string"
                )
              : [],
        }
      : null
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
  // Run-scoped coverage state: what applicable scanners were able to inspect.
  // NOT_APPLICABLE receipts say nothing about coverage; any applicable receipt
  // that did not complete makes coverage partial.
  const applicableReceipts = familyCoverage.filter((receipt) => receipt.status !== "NOT_APPLICABLE")
  const runCoverageState =
    applicableReceipts.length === 0
      ? "None"
      : applicableReceipts.every((receipt) => receipt.status === "COMPLETED")
        ? "Complete"
        : "Partial"
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
              {scan.target ? `${scan.target.name} · ` : ""}
              {getScanGoalLabel(scan.goal)} · {getScanModeLabel(scan.mode)} ·{" "}
              {getScanTriggerLabel(scan.triggerType)}
              {scan.endedAt ? ` · completed ${formatDateTime(scan.endedAt)}` : ""}
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
            {isActive && !refreshError && (
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
            {/* Tamper-evident state stays visible without making the checksum
                primary content; the full checksum lives in technical disclosure. */}
            <Badge
              variant={scan.integrity.manifestChecksum ? "success" : "muted"}
              title="The scan result is sealed into a verifiable manifest"
            >
              {scan.integrity.manifestChecksum ? "Sealed" : isActive ? "Sealing…" : "Not sealed"}
            </Badge>
          </div>
        </div>
      </div>

      {refreshError && (
        <div
          role="status"
          className="border-amber-500/50 bg-amber-500/10 mb-6 flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span>Updates are paused. The displayed scan status may be stale.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleManualRefresh()}
            disabled={refreshing}
          >
            Try again
          </Button>
        </div>
      )}

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
            queuePosition={scan.queuePosition ?? null}
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
          <div
            id={scan.status === "COMPLETED" ? "scan-results-ready" : undefined}
            className="bg-border mb-6 grid gap-px border sm:grid-cols-2 lg:grid-cols-4"
          >
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
                Findings from this scan
              </div>
              <p className="mt-1 text-lg font-semibold">{currentFindings.length}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Retained after scanner layers and deduplication.
              </p>
            </Card>
            <Card className="border-0 p-4 shadow-none">
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Independently verified
              </div>
              <p className="mt-1 text-lg font-semibold">
                {currentFindings.filter((f) => f.verified).length}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Backed by an independent verification receipt.
              </p>
            </Card>
            <Card className="border-0 p-4 shadow-none">
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Coverage state
              </div>
              <p className="mt-1 text-lg font-semibold">{runCoverageState}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                What applicable scanners were able to inspect.
              </p>
            </Card>
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

          {presentation.assuranceAvailable && topFinding && (
            <Card className="border-primary/30 bg-primary/5 mb-6 p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                    Next step
                  </p>
                  <h2 className="mt-1 text-lg font-semibold">
                    Review the highest-priority finding
                  </h2>
                  <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
                    Understand the evidence, record a fix proposal, then queue a fresh retest.
                  </p>
                </div>
                <Link
                  href={`/dashboard/findings?finding=${encodeURIComponent(topFinding.id)}`}
                  className={buttonVariants({ className: "shrink-0" })}
                >
                  Review finding
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
              {presentation.recoveryAction === "usage" ? (
                <Link
                  href="/dashboard/billing"
                  className={buttonVariants({ variant: "outline", className: "mt-3" })}
                >
                  Review usage
                </Link>
              ) : scan.target ? (
                <Link
                  href={scanRecoveryHref({
                    targetId: scan.target.id,
                    goal: scan.goal,
                    mode: scan.mode,
                  })}
                  className={buttonVariants({ variant: "outline", className: "mt-3" })}
                >
                  Start a new scan
                </Link>
              ) : null}
              {scan.errorMessage && (
                <details className="text-foreground mt-3">
                  <summary className="cursor-pointer font-medium">Failure details</summary>
                  <p className="mt-2 wrap-break-word">
                    {presentation.recoveryAction === "usage"
                      ? "Workspace minutes and grace were exhausted."
                      : [
                          scan.errorCategory ? `${safeApiErrorMessage(scan.errorCategory)}: ` : "",
                          scan.status === "STOPPED_BUDGET" ||
                          scan.errorCategory === "BUDGET_EXCEEDED"
                            ? "The protected scan limit was reached."
                            : safeApiErrorMessage(scan.errorMessage),
                        ].join("")}
                  </p>
                </details>
              )}
            </div>
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
              {relayStats && (
                <p className="text-muted-foreground mt-2 text-xs">
                  Engine traffic ran through the scan-scoped relay
                  {relayStats.hosts.length > 0 && ` to ${relayStats.hosts.join(", ")}`}
                  {relayStats.requests !== null &&
                    ` — ${relayStats.requests} audited request${relayStats.requests === 1 ? "" : "s"}`}
                  .
                </p>
              )}
              <p className="text-muted-foreground mt-2 text-xs">
                This public, non-mutating review did not authenticate or validate exploitability.
              </p>
            </Card>
          )}

          {scan.executionPlan && (
            <Card className="mb-6 p-4" aria-labelledby="scan-plan-heading">
              <h2 id="scan-plan-heading" className="font-semibold">
                Scope and plan
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                The immutable plan recorded at creation — it cannot be widened afterward.
              </p>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground text-xs">Workflow</dt>
                  <dd className="mt-0.5 font-medium">
                    {scan.executionPlan.workflow === "REVIEW_CHANGES"
                      ? "Review changes"
                      : scan.executionPlan.workflow === "AUTHENTICATED_ASSESSMENT"
                        ? "Authenticated assessment"
                        : "Review target"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Depth</dt>
                  <dd className="mt-0.5 font-medium">{scan.executionPlan.depth}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Effective scope</dt>
                  <dd className="mt-0.5 font-medium">
                    {scan.executionPlan.scope === "DIFF"
                      ? "Recorded diff"
                      : scan.executionPlan.scope === "LIVE"
                        ? "Live target"
                        : "Snapshot"}
                    {scan.executionPlan.baseRevision
                      ? ` (${scan.executionPlan.baseRevision.slice(0, 7)}…${(scan.executionPlan.sourceRevision ?? "").slice(0, 7)})`
                      : scan.executionPlan.sourceRevision
                        ? ` @ ${scan.executionPlan.sourceRevision.slice(0, 7)}`
                        : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Limits</dt>
                  <dd className="mt-0.5 font-medium">
                    {[
                      scan.executionPlan.maxDurationMinutes
                        ? `Up to ${scan.executionPlan.maxDurationMinutes} minutes`
                        : null,
                      scan.executionPlan.maxRequests
                        ? `${scan.executionPlan.maxRequests} requests`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Bounded run"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Supporting files</dt>
                  <dd className="mt-0.5 font-medium">
                    {scan.executionPlan.attachmentCount > 0
                      ? `${scan.executionPlan.attachmentCount} recorded input${
                          scan.executionPlan.attachmentCount === 1 ? "" : "s"
                        }`
                      : "None"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Authorization</dt>
                  <dd className="mt-0.5 font-medium">
                    {scan.executionPlan.authorizationRequired
                      ? "Delegated authorization recorded"
                      : "Workspace membership"}
                  </dd>
                </div>
              </dl>
              {scan.executionPlan.capabilities.length > 0 && (
                <details className="mt-3">
                  <summary className="text-muted-foreground cursor-pointer text-xs font-medium">
                    Applicable checks
                  </summary>
                  <ul className="text-muted-foreground mt-1 list-inside list-disc text-xs">
                    {scan.executionPlan.capabilities.map((capability) => (
                      <li key={capability}>{capability}</li>
                    ))}
                  </ul>
                </details>
              )}
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
                        {warning.discovery && (
                          <div className="text-muted-foreground mt-2 text-xs">
                            <p>
                              Scanned {warning.discovery.scannedFiles} of{" "}
                              {warning.discovery.eligibleFiles} eligible files;{" "}
                              {warning.discovery.skippedFiles} skipped.
                            </p>
                            {warning.discovery.representativeSkippedPaths.length > 0 && (
                              <details className="mt-1">
                                <summary className="text-foreground cursor-pointer font-medium">
                                  Review skipped-path sample
                                </summary>
                                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                                  {warning.discovery.representativeSkippedPaths.map((filePath) => (
                                    <li key={filePath} className="wrap-break-word font-mono">
                                      {filePath}
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            )}
                          </div>
                        )}
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
              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border p-3">
                  <dt className="text-muted-foreground text-xs">Analysis path</dt>
                  <dd className="mt-1 text-sm font-medium">
                    {reviewProfile.model ? "AI-assisted review" : "Deterministic scanners"}
                  </dd>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Exact execution provenance is retained in the sealed scan manifest.
                  </p>
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

          {(scan.integrity.scopedCoverage ||
            scan.integrity.threatModel ||
            scan.integrity.attachments ||
            (scan.integrity.ingestionWarnings?.length ?? 0) > 0) && (
            <Card className="mb-6 p-4" aria-labelledby="declared-coverage-heading">
              <h2 id="declared-coverage-heading" className="font-semibold">
                Declared coverage and inputs
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Engine-declared evidence recorded in the sealed manifest. These are the
                engine&apos;s own assertions — not independent verification.
              </p>

              {(() => {
                const scoped = scan.integrity.scopedCoverage as
                  | {
                      entries?: Array<{ id?: string; subject?: string; outcome?: string }>
                      gaps?: Array<{ kind?: string; subject?: string; detail?: string }>
                      completeness?: { complete?: boolean; caveats?: string[] }
                    }
                  | null
                  | undefined
                const entries = Array.isArray(scoped?.entries) ? scoped.entries : []
                const gaps = Array.isArray(scoped?.gaps) ? scoped.gaps : []
                const caveats = Array.isArray(scoped?.completeness?.caveats)
                  ? scoped.completeness.caveats
                  : []
                return (
                  <>
                    {(entries.length > 0 || gaps.length > 0 || caveats.length > 0) && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-sm font-medium">
                          Requested vs achieved coverage
                          {entries.length > 0
                            ? ` — ${entries.length} declared item${entries.length === 1 ? "" : "s"}`
                            : ""}
                          {gaps.length > 0
                            ? `, ${gaps.length} declared gap${gaps.length === 1 ? "" : "s"}`
                            : ""}
                        </summary>
                        <div className="mt-2 space-y-2 text-sm">
                          {entries.length > 0 && (
                            <ul className="space-y-1">
                              {entries.slice(0, 25).map((entry, index) => (
                                <li
                                  key={entry.id ?? index}
                                  className="flex flex-wrap items-center gap-2"
                                >
                                  <Badge
                                    variant={
                                      entry.outcome === "needs_follow_up" ? "warning" : "muted"
                                    }
                                  >
                                    {entry.outcome?.replaceAll("_", " ") ?? "declared"}
                                  </Badge>
                                  <span className="text-muted-foreground wrap-break-word">
                                    {entry.subject ?? entry.id}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {gaps.length > 0 && (
                            <ul className="space-y-1">
                              {gaps.slice(0, 25).map((gap, index) => (
                                <li key={index} className="flex flex-wrap items-center gap-2">
                                  <Badge variant="warning">gap</Badge>
                                  <span className="text-muted-foreground wrap-break-word">
                                    {gap.subject ? `${gap.subject}: ` : ""}
                                    {gap.detail ?? gap.kind}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {caveats.slice(0, 10).map((caveat, index) => (
                            <p key={index} className="text-xs text-amber-600">
                              {caveat}
                            </p>
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                )
              })()}

              {scan.integrity.threatModel && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Threat-model assumptions — {scan.integrity.threatModel.modelCount} model
                    {scan.integrity.threatModel.modelCount === 1 ? "" : "s"} declared
                  </summary>
                  <div className="mt-2 space-y-2 text-sm">
                    {(scan.integrity.threatModel.entries ?? []).map((entry, index) => (
                      <div key={index} className="rounded-md border p-2">
                        <p className="text-xs font-medium">{entry.target}</p>
                        <p className="text-muted-foreground mt-1 text-xs wrap-break-word">
                          {entry.preview}
                        </p>
                      </div>
                    ))}
                    <p className="text-muted-foreground text-xs">
                      Sealed artifact checksum:{" "}
                      <code className="font-mono">
                        {scan.integrity.threatModel.checksum.slice(0, 16)}…
                      </code>
                    </p>
                  </div>
                </details>
              )}

              {scan.integrity.attachments && (
                <p className="text-muted-foreground mt-3 text-sm">
                  {scan.integrity.attachments.count} supporting file
                  {scan.integrity.attachments.count === 1 ? "" : "s"} staged read-only and verified
                  against recorded checksums (manifest{" "}
                  <code className="font-mono">
                    {scan.integrity.attachments.manifestChecksum.slice(0, 12)}…
                  </code>
                  ).
                </p>
              )}

              {(scan.integrity.ingestionWarnings?.length ?? 0) > 0 && (
                <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  <p className="text-sm font-medium text-amber-700">
                    {scan.integrity.ingestionWarnings!.length} evidence ingestion issue
                    {scan.integrity.ingestionWarnings!.length === 1 ? "" : "s"} recorded
                  </p>
                  <ul className="text-muted-foreground mt-1 list-inside list-disc text-xs">
                    {scan.integrity.ingestionWarnings!.slice(0, 10).map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          )}

          {scan.aiSecurity && (
            <div className="mb-6">
              <AiSecurityScoreCard data={scan.aiSecurity} />
            </div>
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
              {/* Collapsed by default: the summary line above carries the state;
                  per-scanner receipts are the technical disclosure layer. */}
              <details className="mt-4 rounded-md border">
                <summary className="hover:bg-muted/50 flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
                  Review coverage receipts ({familyCoverage.length})
                  <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
                </summary>
                <div className="grid gap-2 border-t p-4 sm:grid-cols-2 lg:grid-cols-3">
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
                          {humanizeToken(receipt.status)}
                        </Badge>
                      </div>
                      {receipt.reason && (
                        <p className="text-muted-foreground mt-1 text-xs">{receipt.reason}</p>
                      )}
                    </div>
                  ))}
                  {scan.integrity.manifestChecksum && (
                    <p className="text-muted-foreground col-span-full break-all font-mono text-xs">
                      Manifest SHA-256: {scan.integrity.manifestChecksum}
                    </p>
                  )}
                </div>
              </details>
              {(scan.integrity.standards?.length ?? 0) > 0 && (
                <details className="mt-4 rounded-md border">
                  <summary className="hover:bg-muted/50 flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
                    Standards coverage ({scan.integrity.standards!.length} frameworks)
                    <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
                  </summary>
                  <div className="grid gap-3 border-t p-4">
                    {scan.integrity.standards!.map((view) => (
                      <div key={view.standardId} className="rounded-md border p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">
                            {view.name}{" "}
                            <span className="text-muted-foreground text-xs">{view.version}</span>
                          </span>
                          {view.badge && <Badge variant="warning">{view.badge}</Badge>}
                        </div>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {view.evaluated} evaluated · {view.requiresAttestation} require
                          attestation (including evaluated controls) · {view.notEvaluated} not
                          evaluated
                          {view.violationSignals > 0 &&
                            ` · ${view.violationSignals} violation signal${view.violationSignals === 1 ? "" : "s"}`}
                          {view.categories.some((c) => c.limited) && " · † partial coverage"}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {view.categories.map((cat) => (
                            <span
                              key={cat.id}
                              title={`${cat.id} — ${cat.title}${cat.limited ? " (partial coverage)" : ""}`}
                              className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                                cat.state === "evaluated"
                                  ? cat.violationSignals > 0
                                    ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
                                    : cat.limited
                                      ? "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200"
                                      : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                                  : cat.state === "requires-attestation"
                                    ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                                    : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {cat.id}
                              {cat.limited ? "†" : ""}
                              {cat.attestable ? " · attestation required" : ""}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
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
                    “Inconclusive” is expected for many engine-led controls where the scan completed
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
                            <Badge variant={badgeVariant}>{humanizeToken(outcome)}</Badge>
                          </div>
                        )
                      })}
                    </div>
                  </details>
                </div>
              )}
            </Card>
          )}

          {currentFindings.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-1 text-lg font-semibold">
                Findings from this scan ({currentFindings.length})
              </h2>
              <p className="text-muted-foreground mb-3 text-xs">
                Retained after scanner layers and deduplication. Detection is not verification. A
                finding is verified only with an independent verification receipt.
              </p>
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
                                <span>
                                  {getVerificationStatusLabel(finding.verificationStatus)}
                                </span>
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
            <div className="space-y-4">
              <EmptyState
                icon={ShieldCheck}
                title="No findings were reported"
                description={
                  hasLimitedCoverage
                    ? "Some scanner coverage was limited. Review the coverage notice above before treating this as a clean result. Absence of findings is not verification."
                    : "No findings were reported within this scan's completed coverage. Review the retained scope before relying on the result. Absence of findings is not verification."
                }
                action={null}
              />
              {scan.status === "COMPLETED" && (
                <Card className="border-primary/30 bg-primary/5 p-5 sm:p-6">
                  <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                    Next actions
                  </p>
                  <div className="mt-3 grid gap-5 lg:grid-cols-2">
                    <div className="min-w-0">
                      <h2 className="font-semibold">Create an assurance report</h2>
                      <p className="text-muted-foreground mt-1 text-sm">
                        Package this completed scan and its retained scope into an immutable report.
                      </p>
                      <Link
                        href={`/dashboard/findings?tab=reports&scanId=${encodeURIComponent(scan.id)}`}
                        className={buttonVariants({ className: "mt-3" })}
                      >
                        Generate report
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </Link>
                    </div>
                    {scorecard && (
                      <div className="min-w-0 border-t pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
                        <h2 className="font-semibold">Share the scorecard</h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                          Publish only the approved public score fields. Target and vulnerability
                          details stay private.
                        </p>
                        <ScorecardControls
                          targetId={scorecard.targetId}
                          workspaceId={scan.workspaceId}
                          grade={scorecard.grade}
                          canPublish={scorecard.canPublish}
                          existingShare={scorecard.existingShare}
                        />
                      </div>
                    )}
                  </div>
                </Card>
              )}
            </div>
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
