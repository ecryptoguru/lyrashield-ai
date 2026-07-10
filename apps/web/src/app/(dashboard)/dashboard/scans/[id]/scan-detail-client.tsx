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

interface ScanEvent {
  id: string
  stage: string
  level: string
  message: string
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
  createdAt: string
}

const STATUS_VARIANT: Record<string, "default" | "success" | "danger" | "warning" | "info" | "muted"> = {
  QUEUED: "muted",
  PREFLIGHT: "info",
  RUNNING: "default",
  VERIFYING: "default",
  COMPLETED: "success",
  FAILED: "danger",
  CANCELLED: "muted",
  REQUIRES_APPROVAL: "warning",
  STOPPED_BUDGET: "warning",
  TIMED_OUT: "danger",
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
  error: "text-destructive",
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

  const isActive = ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"].includes(scan.status)

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
            createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
          })),
        })
        if (["COMPLETED", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"].includes(updated.status)) {
          const findingsResponse = await fetch(`/api/findings?workspaceId=${updated.workspaceId}&scanId=${scan.id}`)
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
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
  )

  const severityCounts = currentFindings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  const visibleEvents = expandedEvents ? scan.events : scan.events.slice(-10)

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
        <Link href="/dashboard/scans" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to scans
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight">
              <Radar className="h-6 w-6" aria-hidden="true" />
              Scan Details
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {GOAL_LABELS[scan.goal] ?? scan.goal} · {scan.mode} · {scan.triggerType}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isActive && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                </span>
                Live
              </span>
            )}
            <Badge variant={STATUS_VARIANT[scan.status] ?? "muted"} className="text-sm">
              {scan.status}
            </Badge>
          </div>
        </div>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" aria-hidden="true" />
            Duration
          </div>
          <p className="mt-1 text-lg font-semibold">
            {formatDuration(scan.startedAt, scan.endedAt)}
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
            Findings
          </div>
          <p className="mt-1 text-lg font-semibold">{currentFindings.length}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Verified
          </div>
          <p className="mt-1 text-lg font-semibold">
            {currentFindings.filter((f) => f.verified).length}
          </p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <XCircle className="h-4 w-4" aria-hidden="true" />
            Status
          </div>
          <p className="mt-1 text-lg font-semibold">{scan.status}</p>
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

      {scan.errorMessage && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <p className="font-semibold">{scan.errorCategory}</p>
          <p className="mt-1">{scan.errorMessage}</p>
        </div>
      )}

      {scan.summary && (
        <Card className="mb-6 p-4">
          <h2 className="mb-1 text-sm font-semibold">Summary</h2>
          <p className="text-sm text-muted-foreground">{scan.summary}</p>
        </Card>
      )}

      {currentFindings.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-3 text-lg font-semibold">
            Findings ({currentFindings.length})
          </h2>
          {Object.entries(severityCounts)
            .sort(([a], [b]) => (SEVERITY_ORDER[a] ?? 99) - (SEVERITY_ORDER[b] ?? 99))
            .map(([sev, count]) => {
              const Icon = SEVERITY_ICON[sev] ?? Shield
              return (
                <span key={sev} className={`mr-3 inline-flex items-center gap-1 text-sm font-medium ${SEVERITY_COLOR[sev] ?? ""}`}>
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
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="muted">{finding.severity}</Badge>
                          {finding.cwe && <span>CWE: {finding.cwe}</span>}
                          {finding.cvssScore !== null && <span>CVSS: {finding.cvssScore}</span>}
                          {finding.verified && (
                            <span className="text-emerald-600 dark:text-emerald-400">Verified</span>
                          )}
                        </div>
                      </div>
                    </div>
                    {isExpanded ? (
                      <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                  </button>
                  {isExpanded && finding.summary && (
                    <div
                      id={`finding-${finding.id}-detail`}
                      className="mt-3 border-t pt-3 text-sm text-muted-foreground"
                    >
                      {finding.summary}
                    </div>
                  )}
                </Card>
              )
            })}
          </div>
        </div>
      )}

      {currentFindings.length === 0 && !isActive && (
        <EmptyState
          icon={ShieldCheck}
          title="No findings"
          description="This scan completed without any findings."
        />
      )}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Scan Events ({scan.events.length})</h2>
          {scan.events.length > 10 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpandedEvents(!expandedEvents)}
            >
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
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {new Date(event.createdAt).toLocaleTimeString()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className={`font-mono text-xs ${EVENT_LEVEL_COLOR[event.level] ?? "text-muted-foreground"}`}>
                      [{event.stage}]
                    </span>
                    <span className="ml-2 wrap-break-word">{event.message}</span>
                  </div>
                  {idx === 0 && !expandedEvents && scan.events.length > 10 && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      +{scan.events.length - 10} earlier
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
