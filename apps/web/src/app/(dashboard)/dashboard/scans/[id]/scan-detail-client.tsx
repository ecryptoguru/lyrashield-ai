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
  Clock,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from "lucide-react"
import { Card, Badge, Button, EmptyState, buttonVariants } from "@lyrashield/ui"
import { formatTime, formatDateTime } from "@/lib/date-format"
import { getScannerCoverageWarnings } from "@/lib/scan-coverage"
import { getScanPresentation, isActiveScan } from "@/lib/scan-presentation"
import { ScanQualitySurfaceSchema } from "@lyrashield/types"
import { findingDetailItemsPaginatedSchema, scanPollDataSchema } from "@/lib/api-schemas"
import { apiGet, apiGetConditional, apiGetPaginated } from "@/lib/api-client"
import {
  getScanGoalLabel,
  getScanModeLabel,
  getScanTriggerLabel,
  getTargetTypeLabel,
} from "@/lib/enum-labels"
import { ScanInProgress } from "./scan-in-progress"
import { ScanCoverageDetail, ScanFindingsSection } from "./scan-detail-sections"
import { ScanEvidenceSections } from "./scan-evidence-sections"
import { useScanDetailWebMcp } from "./scan-detail-webmcp"
import { AiSecurityScoreCard } from "./ai-score-card"
import { track } from "@/lib/analytics"
import { presentOperationFailure } from "@/lib/operation-failure"
import { findingsHref, reportsHref } from "@/lib/finding-list-params"
import { scanRecoveryHref } from "../scans-client.utils"
import type { CleanResultScorecard, FindingItem, ScanData, ScanPollData } from "./scan-detail-types"
import {
  EVENT_LEVEL_COLOR,
  INTERNAL_ACCOUNTING_EVENT_STAGES,
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

  // Page-scoped agent read: `review_scan_progress` can only ever resolve the
  // scan this page displays; workspace/scan identity is bound at registration.
  useScanDetailWebMcp({ workspaceId: scan.workspaceId, scanId: scan.id })
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
        let refreshedQuality: ScanData["integrity"]["quality"] = null
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
          // The poll carries coverage receipts but the evidence-quality
          // projection is server-rendered. Refresh it after persistence so a
          // live page cannot show the pre-scan zero beside terminal receipts.
          try {
            refreshedQuality = await apiGet(
              `/api/scans/${scan.id}/quality?workspaceId=${encodeURIComponent(updated.workspaceId)}`,
              { signal, schema: ScanQualitySurfaceSchema }
            )
          } catch {
            // Keep the terminal outcome visible; omit a stale quality snapshot.
          }
          nextScan.integrity.quality = refreshedQuality
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
  const scanRecovery = presentation.showFailureDetails
    ? presentOperationFailure(scan.errorCategory ?? scan.status, {
        targetName: scan.target?.name,
      })
    : null
  const nextAction = isActive
    ? {
        kind: "refresh" as const,
        label: "Refresh scan status",
        description: "Read the latest accepted scan status. This does not start another scan.",
      }
    : scan.status === "PARTIAL" && scan.target
      ? {
          kind: "link" as const,
          label: "Complete coverage",
          href: scanRecoveryHref({
            targetId: scan.target.id,
            goal: scan.goal,
            mode: scan.mode,
          }),
          description:
            "Review the recorded limitations, then use the existing scan flow to request another scan for this target.",
        }
      : currentFindings.length > 0
        ? {
            kind: "link" as const,
            label: "Review highest-priority finding",
            href: findingsHref({
              tab: "issues",
              finding: topFinding!.id,
              scanId: scan.id,
              ...(scan.target ? { target: scan.target.id } : {}),
            }),
            description:
              "Review the retained evidence first. Detection is not verification; propose a fix only after reviewing its scope.",
          }
        : scanRecovery
          ? {
              kind: "link" as const,
              label:
                presentation.recoveryAction === "usage"
                  ? "Review account usage"
                  : "Review scan recovery",
              href:
                presentation.recoveryAction === "usage"
                  ? "/dashboard/billing"
                  : (scanRecovery.recoveryHref ??
                    (scan.target
                      ? scanRecoveryHref({
                          targetId: scan.target.id,
                          goal: scan.goal,
                          mode: scan.mode,
                        })
                      : "/dashboard/scans")),
              description: scanRecovery.recovery,
            }
          : scan.status === "COMPLETED" && runCoverageState === "Complete" && !hasLimitedCoverage
            ? {
                kind: "link" as const,
                label: "Create an assurance report",
                href: reportsHref({
                  scanId: scan.id,
                  ...(scan.target ? { targetId: scan.target.id } : {}),
                }),
                description:
                  "Package this scan and its recorded scope into an immutable report for your team.",
              }
            : {
                kind: "link" as const,
                label: scan.target ? "Review target setup" : "Review scans",
                href: scan.target
                  ? `/dashboard/targets/${encodeURIComponent(scan.target.id)}`
                  : "/dashboard/scans",
                description:
                  "This scan does not have complete usable coverage. Review the visible limitations before deciding what to do next.",
              }
  const coverageSummary = isActive
    ? "Coverage is still being recorded; this is not a completed result."
    : scan.status === "COMPLETED" && runCoverageState === "Complete" && !hasLimitedCoverage
      ? "Applicable scanner receipts completed within the recorded scope."
      : runCoverageState === "Partial" || scan.status === "PARTIAL" || hasLimitedCoverage
        ? "Coverage is partial or has a recorded limitation. Findings are available, but a clean result cannot be treated as complete."
        : "No complete applicable coverage was recorded. This scan does not support an assurance conclusion."
  const displayedCoverageState =
    (scan.status === "PARTIAL" || hasLimitedCoverage) && runCoverageState === "Complete"
      ? "Complete with limitations"
      : runCoverageState
  function toggleFinding(id: string) {
    setExpandedFindings((current) => {
      const next = new Set(current)
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

      <section
        id="scan-evidence-summary"
        className="border-primary/30 bg-primary/[0.04] mb-6 rounded-xl border p-5 sm:p-6"
        aria-labelledby="scan-next-action"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
              {isActive ? "In progress" : "Evidence summary"}
            </p>
            <h2 id="scan-next-action" className="mt-1 text-lg font-semibold">
              {nextAction.kind === "refresh" ? "Scan in progress" : nextAction.label}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">{nextAction.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span>
                <span className="text-muted-foreground">Target: </span>
                <span className="font-medium">
                  {scan.target?.name ?? "Target details unavailable"}
                </span>
                {scan.target && (
                  <span className="text-muted-foreground">
                    {" · "}
                    {getTargetTypeLabel(scan.target.type)}
                  </span>
                )}
              </span>
              <span className="inline-flex items-center gap-1.5">
                {runCoverageState === "Complete" && !hasLimitedCoverage ? (
                  <ShieldCheck className="text-primary size-4" aria-hidden="true" />
                ) : (
                  <ShieldAlert className="text-amber-600 size-4" aria-hidden="true" />
                )}
                <span className="font-medium">Coverage: {displayedCoverageState}</span>
              </span>
            </div>
            <p className="text-muted-foreground mt-2 text-sm">{coverageSummary}</p>
            {scan.executionPlan && (
              <p className="text-muted-foreground mt-1 text-xs">
                Recorded scope:{" "}
                {scan.executionPlan.scope === "DIFF" ? "exact diff" : "target snapshot"}
                {scan.executionPlan.sourceRevision
                  ? ` · revision ${scan.executionPlan.sourceRevision.slice(0, 7)}`
                  : ""}
                {scan.executionPlan.baseRevision
                  ? ` from ${scan.executionPlan.baseRevision.slice(0, 7)}`
                  : ""}
              </p>
            )}
            {hasLimitedCoverage && (
              <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                {coverageWarnings.length} coverage limitation
                {coverageWarnings.length === 1 ? "" : "s"} are listed below.
              </p>
            )}
          </div>
          {nextAction.kind === "refresh" ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0"
              onClick={() => void handleManualRefresh()}
              disabled={refreshing}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              Refresh status
            </Button>
          ) : (
            <Link
              href={nextAction.href}
              className={`${buttonVariants({ className: "shrink-0" })} min-h-11`}
            >
              {nextAction.label}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          )}
        </div>
      </section>

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

          <ScanEvidenceSections
            scan={scan}
            presentation={presentation}
            coverageWarnings={coverageWarnings}
            controlCoverage={controlCoverage}
            controlOutcomeCounts={controlOutcomeCounts}
          />

          {scan.aiSecurity && (
            <div className="mb-6">
              <AiSecurityScoreCard data={scan.aiSecurity} />
            </div>
          )}

          <ScanCoverageDetail
            scan={scan}
            familyCoverage={familyCoverage}
            controlCoverage={controlCoverage}
            incompleteCoverageCount={incompleteCoverage.length}
            controlOutcomeCounts={controlOutcomeCounts}
          />

          <ScanFindingsSection
            currentFindings={currentFindings}
            sortedFindings={sortedFindings}
            scan={scan}
            scorecard={scorecard}
            hasLimitedCoverage={hasLimitedCoverage}
            assuranceAvailable={presentation.assuranceAvailable}
            isActive={isActive}
            expandedFindings={expandedFindings}
            onToggleFinding={toggleFinding}
          />
        </>
      )}

      <details id="technical-details" className="group">
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
              headingLevel="h3"
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
