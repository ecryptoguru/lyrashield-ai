"use client"

import { useEffect, useRef } from "react"
import {
  Activity,
  CheckCircle2,
  Circle,
  Clock,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react"
import { Badge, Button, Card } from "@lyrashield/ui"
import { formatTime } from "@/lib/date-format"
import { estimateRunMinutes, formatEstimate } from "@/lib/estimator"

interface ScanEvent {
  id: string
  stage: string
  level: string
  message: string
  metadata?: Record<string, unknown> | null
  createdAt: string
}

/** Strip leading [stage] prefixes like "[preflight] Starting…" → "Starting…" */
function stripStagePrefix(msg: string): string {
  return msg.replace(/^\[[^\]]+\]\s*/, "")
}

/** Humanize a scan status string into a readable stage label. */
function humanizeStatus(status: string): string {
  switch (status) {
    case "QUEUED":
      return "Waiting to start"
    case "PREFLIGHT":
      return "Checking setup"
    case "RUNNING":
      return "Scanning"
    case "VERIFYING":
      return "Verifying evidence"
    default:
      return status.charAt(0) + status.slice(1).toLowerCase().replaceAll("_", " ")
  }
}

/** Derive current stage label from the latest non-accounting event. */
function deriveCurrentStage(status: string, events: ScanEvent[]): string {
  if (events.length > 0) {
    const latest = events[events.length - 1]!
    const stripped = stripStagePrefix(latest.message)
    if (stripped.length > 0) return stripped
  }
  return humanizeStatus(status)
}

type StageState = "done" | "active" | "pending"

interface Phase {
  key: string
  label: string
  state: StageState
}

/**
 * Derive the ordered phase checklist from the scan status and event stream.
 * Only surfaces phases evidenced by the data — no fabrication.
 */
function derivePhases(status: string, events: ScanEvent[]): Phase[] {
  const stages = new Set(events.map((e) => e.stage.toLowerCase()))

  const hasPreflight = stages.has("preflight") || status === "PREFLIGHT"
  const hasRunning = stages.has("running") || status === "RUNNING" || status === "VERIFYING"
  const hasVerifying = stages.has("verifying") || status === "VERIFYING"

  const phases: Phase[] = []

  if (hasPreflight) {
    let state: StageState
    if (status === "PREFLIGHT") {
      state = "active"
    } else if (hasRunning || hasVerifying) {
      state = "done"
    } else {
      state = "pending"
    }
    phases.push({ key: "preflight", label: "Setup check", state })
  }

  if (hasRunning) {
    let state: StageState
    if (status === "RUNNING") {
      state = "active"
    } else if (status === "VERIFYING") {
      state = "done"
    } else if (hasPreflight && status === "PREFLIGHT") {
      state = "pending"
    } else {
      state = "active"
    }
    phases.push({ key: "running", label: "Scanning", state })
  }

  if (hasVerifying) {
    const state: StageState = status === "VERIFYING" ? "active" : "pending"
    phases.push({ key: "verifying", label: "Verifying evidence", state })
  }

  // Fallback: if no phases derived (e.g. QUEUED with no events), show current status
  if (phases.length === 0) {
    phases.push({ key: status.toLowerCase(), label: humanizeStatus(status), state: "active" })
  }

  return phases
}

interface ScanInProgressProps {
  status: string
  mode: string
  startedAt: string | null
  elapsedTime: string
  events: ScanEvent[]
  findingsCount: number
  /**
   * The scan's place in the run queue while QUEUED (1-based position + total
   * waiting). Null once it is running or if the position is unknown.
   */
  queuePosition?: { position: number; waiting: number } | null
  /**
   * Lets the user pull an update on demand. Polling backs off to 60s and pauses entirely
   * while the tab is hidden, so someone watching a long review can otherwise sit in front
   * of a screen that looks stalled with no way to ask.
   */
  onRefresh?: () => void
  refreshing?: boolean
}

export function ScanInProgress({
  status,
  mode,
  startedAt,
  elapsedTime,
  events,
  findingsCount,
  queuePosition,
  onRefresh,
  refreshing = false,
}: ScanInProgressProps) {
  const currentStage = deriveCurrentStage(status, events)
  const phases = derivePhases(status, events)
  const estimatedTime = formatEstimate(estimateRunMinutes(mode))
  const feedRef = useRef<HTMLUListElement>(null)

  // Auto-scroll the feed to show newest events
  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [events.length])

  const recentEvents = events.slice(-10)

  return (
    <div className="space-y-4">
      {/* Status hero card */}
      <Card
        className="overflow-hidden p-0"
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="Scan in progress"
      >
        {/*
          Indeterminate progress affordance: a pulsing bar.
          The global prefers-reduced-motion rule kills the animation;
          the bar remains visible as a static teal stripe.
        */}
        <div
          className="h-1 w-full bg-teal-500/20"
          role="progressbar"
          aria-valuetext="Scan in progress — indeterminate"
          aria-label="Scan progress"
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full w-full animate-pulse bg-teal-500/60" />
        </div>

        <div className="p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            {/* Left: headline + meta */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-teal-500" />
                </span>
                <p className="text-xs font-semibold tracking-widest text-teal-600 uppercase dark:text-teal-400">
                  {humanizeStatus(status)}
                </p>
              </div>

              <h2
                className="mt-2 text-xl leading-tight font-semibold sm:text-2xl"
                aria-label={`Current stage: ${currentStage}`}
              >
                {currentStage}
              </h2>

              <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                {status === "QUEUED" && queuePosition && (
                  <span className="flex items-center gap-1.5 font-medium text-teal-600 dark:text-teal-400">
                    <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="tabular-nums">
                      In queue: {queuePosition.position} of {queuePosition.waiting}
                    </span>
                  </span>
                )}
                {startedAt && (
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>
                      Elapsed: <span className="font-medium tabular-nums">{elapsedTime}</span>
                    </span>
                  </span>
                )}
                <span className="font-medium">Estimated time: {estimatedTime}</span>
                {onRefresh && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={onRefresh}
                    disabled={refreshing}
                    className="h-7 px-2 text-xs"
                  >
                    <RefreshCw
                      className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
                      aria-hidden="true"
                    />
                    {refreshing ? "Refreshing" : "Refresh now"}
                  </Button>
                )}
                {findingsCount > 0 && (
                  <span className="flex items-center gap-1.5">
                    <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>
                      Findings so far:{" "}
                      <span
                        className="font-medium tabular-nums"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        {findingsCount}
                      </span>
                    </span>
                  </span>
                )}
              </div>

              <p className="text-muted-foreground mt-3 max-w-prose text-sm">
                Most scans finish sooner; large repositories can use the full selected review limit.
                This page updates automatically.
              </p>
            </div>

            {/* Right: stage checklist */}
            {phases.length > 0 && (
              <ol className="flex shrink-0 flex-col gap-2.5 sm:items-end" aria-label="Scan phases">
                {phases.map((phase) => (
                  <li key={phase.key} className="flex items-center gap-2 text-sm">
                    {phase.state === "done" && (
                      <>
                        <CheckCircle2
                          className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400"
                          aria-hidden="true"
                        />
                        <span className="text-teal-600 dark:text-teal-400">{phase.label}</span>
                        <Badge variant="success" className="text-xs">
                          Done
                        </Badge>
                      </>
                    )}
                    {phase.state === "active" && (
                      <>
                        <Loader2
                          className="h-4 w-4 shrink-0 animate-spin text-amber-600 dark:text-amber-400"
                          aria-hidden="true"
                        />
                        <span className="font-medium text-amber-600 dark:text-amber-400">
                          {phase.label}
                        </span>
                        <Badge variant="warning" className="text-xs">
                          Active
                        </Badge>
                      </>
                    )}
                    {phase.state === "pending" && (
                      <>
                        <Circle
                          className="text-muted-foreground h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="text-muted-foreground">{phase.label}</span>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </Card>

      {/* Live findings counter — shown only once findings arrive */}
      {findingsCount > 0 && (
        <Card className="flex items-center gap-3 p-4">
          <ShieldAlert
            className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold">
              <span
                className="tabular-nums"
                aria-live="polite"
                aria-atomic="true"
                aria-label={`${findingsCount} finding${findingsCount === 1 ? "" : "s"} detected so far`}
              >
                {findingsCount}
              </span>{" "}
              finding{findingsCount === 1 ? "" : "s"} detected so far
            </p>
            <p className="text-muted-foreground text-xs">
              Final counts may change as verification completes.
            </p>
          </div>
        </Card>
      )}

      {/* Live activity feed */}
      {recentEvents.length > 0 && (
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <Activity
              className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400"
              aria-hidden="true"
            />
            <h3 className="text-sm font-semibold">Live activity</h3>
            <span className="text-muted-foreground text-xs">
              (last {recentEvents.length} event{recentEvents.length === 1 ? "" : "s"})
            </span>
          </div>
          <ul
            ref={feedRef}
            className="max-h-56 space-y-1 overflow-y-auto"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="Scan activity feed"
            tabIndex={0}
          >
            {recentEvents.map((event, idx) => {
              const isNewest = idx === recentEvents.length - 1
              return (
                <li
                  key={event.id}
                  className={`flex items-start gap-2 rounded px-2 py-1 text-xs ${
                    isNewest ? "text-foreground bg-teal-500/10" : "text-muted-foreground"
                  }`}
                >
                  <span className="shrink-0 tabular-nums">{formatTime(event.createdAt)}</span>
                  <span className="min-w-0 wrap-break-word">{stripStagePrefix(event.message)}</span>
                  {isNewest && (
                    <span className="ml-auto shrink-0" aria-hidden="true">
                      <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-teal-500" />
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>
      )}
    </div>
  )
}
