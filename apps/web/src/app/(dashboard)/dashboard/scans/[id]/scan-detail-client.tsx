"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import Link from "next/link"
import {
  ArrowLeft,
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
} from "lucide-react"
import { Card, Badge, Button, EmptyState } from "@lyrashield/ui"
import { formatTime } from "@/lib/date-format"
import { getScannerCoverageWarnings } from "@/lib/scan-coverage"
import { getScanPresentation, isActiveScan } from "@/lib/scan-presentation"

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
    coverage: Array<{ scanner: string; controlId: string; status: string; reason: string | null }>
  }
}

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

const GOAL_LABELS: Record<string, string> = {
  CHECK_PR: "Check PR",
  TEST_APP: "Test App",
  LAUNCH_REVIEW: "Launch Review",
  WEEKLY_MONITOR: "Weekly Monitor",
  FULL_PENTEST: "Full Pentest",
  COMPLIANCE_REVIEW: "Compliance Review",
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
  url: "URL scan",
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isActive = isActiveScan(scan.status)
  const presentation = getScanPresentation(scan.status)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/scans/${scan.id}`, { headers: { Accept: "application/json" } })
      if (!res.ok) return
      const json = await res.json()
      if (json.data) {
        const updated = json.data
        setScan({
          ...updated,
          startedAt: updated.startedAt ?? null,
          endedAt: updated.endedAt ?? null,
          events: (updated.events ?? []).map((e: { createdAt: string | Date }) => ({
            ...e,
            createdAt:
              e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
          })),
        })
        if (
          ["COMPLETED", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"].includes(
            updated.status
          )
        ) {
          const findingsResponse = await fetch(
            `/api/findings?workspaceId=${updated.workspaceId}&scanId=${scan.id}`
          )
          if (findingsResponse.ok) {
            const findingsJson = await findingsResponse.json()
            if (Array.isArray(findingsJson.data)) setCurrentFindings(findingsJson.data)
          }
        }
      }
    } catch {
      // Network errors during polling are non-fatal — keep showing stale data
    }
  }, [scan.id])

  useEffect(() => {
    if (!isActive) return
    pollRef.current = setInterval(refresh, 5000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [isActive, refresh])

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

  const visibleEvents = expandedEvents ? scan.events : scan.events.slice(-10)
  const coverageWarnings = getScannerCoverageWarnings(scan.events)
  const hasLimitedCoverage = coverageWarnings.length > 0
  const incompleteCoverage = scan.integrity.coverage.filter(
    (receipt) => !["COMPLETED", "NOT_APPLICABLE"].includes(receipt.status)
  )

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
      <div className="mb-6">
        <Link
          href="/dashboard/scans"
          className="text-muted-foreground hover:text-foreground mb-3 inline-flex min-h-11 items-center gap-1.5 px-1 text-sm"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to scans
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight">
              <Radar className="h-6 w-6" aria-hidden="true" />
              {presentation.headline}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {GOAL_LABELS[scan.goal] ?? scan.goal} · {scan.mode} · {scan.triggerType}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isActive && (
              <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
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

      <div className="bg-border mb-6 grid gap-px border sm:grid-cols-2 lg:grid-cols-5">
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
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Result integrity
          </div>
          <p className="mt-1 text-lg font-semibold">
            {scan.integrity.manifestChecksum ? "Manifested" : "Pending"}
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

      {presentation.showFailureDetails && (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/10 mb-6 border-l-2 p-4 text-sm"
        >
          <p className="font-semibold">{presentation.headline}</p>
          <p className="text-foreground/80 mt-1">{presentation.description}</p>
          {scan.errorMessage && (
            <details className="text-foreground/80 mt-3">
              <summary className="cursor-pointer font-medium">Failure details</summary>
              <p className="mt-2 wrap-break-word">
                {scan.errorCategory ? `${scan.errorCategory}: ` : ""}
                {scan.errorMessage}
              </p>
            </details>
          )}
        </div>
      )}

      {scan.summary && presentation.assuranceAvailable && (
        <Card className="mb-6 p-4">
          <h2 className="mb-1 text-sm font-semibold">Summary</h2>
          <p className="text-muted-foreground text-sm">{scan.summary}</p>
        </Card>
      )}

      {hasLimitedCoverage && (
        <section
          aria-labelledby="coverage-warning-heading"
          className="mb-6 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h2 id="coverage-warning-heading" className="font-semibold">
                Some scanner coverage was limited
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Results are available, but the checks below could not fully evaluate every supported
                input. Review them before treating this scan as a complete clean result.
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
            {scan.integrity.coverage.map((receipt) => (
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
                          <Badge variant="muted">{finding.severity}</Badge>
                          {finding.cwe && <span>CWE: {finding.cwe}</span>}
                          {finding.cvssScore !== null && <span>CVSS: {finding.cvssScore}</span>}
                          {finding.verified && (
                            <span className="text-emerald-600 dark:text-emerald-400">Verified</span>
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
          title={hasLimitedCoverage ? "No findings were reported" : "No findings"}
          description={
            hasLimitedCoverage
              ? "Some scanner coverage was limited. Review the coverage notice above before treating this as a clean result."
              : scan.status === "COMPLETED"
                ? "This scan completed without any findings."
                : "No findings were recorded before this scan ended."
          }
        />
      )}

      <details className="group">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 border-y py-3 text-sm font-semibold marker:hidden">
          <span>Technical details</span>
          <span className="text-muted-foreground text-xs font-normal">
            {scan.events.length} event{scan.events.length === 1 ? "" : "s"}
          </span>
        </summary>
        <div className="pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Scan events</h2>
            {scan.events.length > 10 && (
              <Button variant="ghost" size="sm" onClick={() => setExpandedEvents(!expandedEvents)}>
                {expandedEvents ? "Show last 10" : `Show all ${scan.events.length}`}
              </Button>
            )}
          </div>
          {scan.events.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No events"
              description="No scan events have been recorded yet."
            />
          ) : (
            <Card className="p-4">
              <div className="space-y-2">
                {visibleEvents.map((event, idx) => (
                  <div
                    key={event.id}
                    className="flex items-start gap-3 border-b pb-2 text-sm last:border-0 last:pb-0"
                  >
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
                    {idx === 0 && !expandedEvents && scan.events.length > 10 && (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        +{scan.events.length - 10} earlier
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
