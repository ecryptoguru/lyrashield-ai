"use client"

import { useState, useEffect, useCallback } from "react"
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
} from "lucide-react"
import { Card, Badge, Button, EmptyState, buttonVariants } from "@lyrashield/ui"
import { formatTime } from "@/lib/date-format"
import { getScannerCoverageWarnings } from "@/lib/scan-coverage"
import { getScanPresentation, isActiveScan } from "@/lib/scan-presentation"
import { getScanReviewProfile } from "@/lib/scan-review-profile"
import { apiGet, apiGetPaginated } from "@/lib/api-client"

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
  cost: {
    providerUsd: string | null
    billedUsd: string | null
    legacyBilledCents: number | null
    requestCount: number | null
    inputTokens: number | null
    cachedInputTokens: number | null
    outputTokens: number | null
  }
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
    coverage: Array<{
      scanner: string
      controlId: string
      status: string
      reason: string | null
      subject: string | null
      metadata: Record<string, unknown> | null
    }>
  }
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
  providerCostUsd?: string | number | null
  billedCostUsd?: string | number | null
  actualCostCents?: number | null
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
  FULL_PENTEST: "Deep Security Review",
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
  secrets: "Secret scan",
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

  const isActive = isActiveScan(scan.status)
  const presentation = getScanPresentation(scan.status)

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const updated = await apiGet<ScanPollData>(`/api/scans/${scan.id}`, { signal })
        setScan({
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
            manifestChecksum: updated.resultManifest?.checksum ?? null,
            coverage: (updated.coverageReceipts ?? []).map((receipt) => ({
              scanner: receipt.scanner,
              controlId: receipt.controlId,
              status: receipt.status,
              reason: receipt.reason ?? null,
              subject: receipt.subject ?? null,
              metadata: asMetadata(receipt.metadata),
            })),
          },
          cost: {
            providerUsd:
              updated.providerCostUsd !== null && updated.providerCostUsd !== undefined
                ? String(updated.providerCostUsd)
                : null,
            billedUsd:
              updated.billedCostUsd !== null && updated.billedCostUsd !== undefined
                ? String(updated.billedCostUsd)
                : null,
            legacyBilledCents: updated.actualCostCents ?? null,
            requestCount: updated.llmRequestCount ?? null,
            inputTokens: updated.llmInputTokens ?? null,
            cachedInputTokens: updated.llmCachedInputTokens ?? null,
            outputTokens: updated.llmOutputTokens ?? null,
          },
        })
        if (
          ["COMPLETED", "FAILED", "CANCELLED", "STOPPED_BUDGET", "TIMED_OUT"].includes(
            updated.status
          )
        ) {
          const refreshedFindings: FindingItem[] = []
          let cursor: string | undefined
          do {
            const page = await apiGetPaginated<FindingItem>(
              "/api/findings",
              { workspaceId: updated.workspaceId, scanId: scan.id, cursor, limit: "100" },
              { signal }
            )
            refreshedFindings.push(...page.items)
            cursor = page.nextCursor ?? undefined
          } while (cursor && !signal.aborted)
          if (!signal.aborted) setCurrentFindings(refreshedFindings)
        }
      } catch {
        // Network errors during polling are non-fatal — keep showing stale data
      }
    },
    [scan.id, scan.target]
  )

  useEffect(() => {
    if (!isActive) return
    const controller = new AbortController()
    let timeoutId: number | undefined
    const poll = async () => {
      await refresh(controller.signal)
      if (!controller.signal.aborted) timeoutId = window.setTimeout(poll, 5000)
    }
    timeoutId = window.setTimeout(poll, 5000)
    return () => {
      controller.abort()
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
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
  const billedCost =
    scan.cost.billedUsd ??
    (scan.cost.legacyBilledCents !== null ? (scan.cost.legacyBilledCents / 100).toFixed(2) : null)

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

      {presentation.assuranceAvailable && (
        <Card className="border-primary/30 bg-primary/5 mb-6 p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-primary text-xs font-semibold tracking-[0.14em] uppercase">
                Next step
              </p>
              <h2 className="mt-1 text-lg font-semibold">
                {topFinding ? "Review the highest-priority finding" : "Create an assurance report"}
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
                  : `/dashboard/reports?scanId=${encodeURIComponent(scan.id)}`
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

      {(scan.integrity.coverage.length > 0 ||
        reviewProfile.model ||
        reviewProfile.maxBudgetUsd) && (
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
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
              <dt className="text-muted-foreground text-xs">Approved budget cap</dt>
              <dd className="mt-1 text-sm font-medium">
                {reviewProfile.maxBudgetUsd ? `$${reviewProfile.maxBudgetUsd.toFixed(2)}` : "—"}
              </dd>
              {reviewProfile.budgetSource && (
                <p className="text-muted-foreground mt-1 text-xs">
                  {reviewProfile.budgetSource.replaceAll("_", " ")}
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
            <div className="rounded-md border p-3">
              <dt className="text-muted-foreground text-xs">Billed engine cost</dt>
              <dd className="mt-1 text-sm font-medium">
                {billedCost !== null ? `$${Number(billedCost).toFixed(6)}` : "Not reported"}
              </dd>
              <p className="text-muted-foreground mt-1 text-xs">
                {scan.cost.providerUsd !== null && scan.cost.providerUsd !== billedCost
                  ? `$${Number(scan.cost.providerUsd).toFixed(6)} engine-reported before cap`
                  : scan.cost.inputTokens !== null || scan.cost.outputTokens !== null
                    ? `${(scan.cost.inputTokens ?? 0).toLocaleString()} in · ${(scan.cost.outputTokens ?? 0).toLocaleString()} out`
                    : scan.target?.type === "REPO"
                      ? "Waiting for engine usage"
                      : "AI engine not invoked"}
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
                “No finding returned” means an applicable scanner completed without reporting this
                issue. It is not an independent verification or a security guarantee.
              </p>
              <details className="mt-4 rounded-md border">
                <summary className="hover:bg-muted/50 flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
                  Review all 50 control receipts
                  <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
                </summary>
                <div className="border-t">
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
                        className="grid gap-2 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {rank ? `${rank}. ` : ""}
                            {title}
                          </p>
                          {receipt.reason && (
                            <p className="text-muted-foreground mt-1 text-xs">{receipt.reason}</p>
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
          title="No findings were reported"
          description={
            hasLimitedCoverage
              ? "Some scanner coverage was limited. Review the coverage notice above before treating this as a clean result."
              : scan.status === "COMPLETED"
                ? "No findings were reported within this scan's completed coverage. Review the retained scope before relying on the result."
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
