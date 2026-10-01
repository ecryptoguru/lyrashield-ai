"use client"

import { useState } from "react"
import Link from "next/link"
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Radar,
} from "lucide-react"
import { Badge, Button, Card, EmptyState, buttonVariants } from "@lyrashield/ui"
import {
  getScanGoalLabel,
  getScanModeLabel,
  getScanTriggerLabel,
  getTargetTypeLabel,
  getVerificationStatusLabel,
} from "@/lib/enum-labels"
import { formatDateTime, formatDuration, formatTime } from "@/lib/date-format"
import type { getScanPresentation } from "@/lib/scan-presentation"
import { severityLabel, humanizeToken } from "@/lib/labels"
import { reportsHref } from "@/lib/finding-list-params"
import { ScorecardControls } from "../../targets/[id]/scorecard-controls"
import { ScanEvidenceSections } from "./scan-evidence-sections"
import { AiSecurityScoreCard } from "./ai-score-card"
import {
  EVENT_LEVEL_COLOR,
  SCANNER_LABELS,
  SEVERITY_COLOR,
  SEVERITY_ICON,
  SEVERITY_ORDER,
  type ScanDetailView,
  type ScanNextAction,
} from "./scan-detail-presentation"
import type { CompletionNotice } from "./scan-detail-utils"
import type { CleanResultScorecard, FindingItem, ScanData } from "./scan-detail-types"

type ScanPresentationResult = ReturnType<typeof getScanPresentation>

type CoverageReceipt = ScanData["integrity"]["coverage"][number]

export function ScanCoverageDetail({
  scan,
  familyCoverage,
  controlCoverage,
  incompleteCoverageCount,
  controlOutcomeCounts,
}: {
  scan: ScanData
  familyCoverage: CoverageReceipt[]
  controlCoverage: CoverageReceipt[]
  incompleteCoverageCount: number
  controlOutcomeCounts: Record<string, number>
}) {
  return (
    <>
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
            <Badge variant={incompleteCoverageCount > 0 ? "warning" : "success"}>
              {incompleteCoverageCount > 0 ? "Coverage limited" : "Coverage recorded"}
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
                      {view.evaluated} evaluated · {view.requiresAttestation} require attestation
                      (including evaluated controls) · {view.notEvaluated} not evaluated
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
                “No finding returned” means an applicable scanner completed without reporting this
                issue. It is not an independent verification or a security guarantee.
              </p>
              <p className="text-muted-foreground mt-2 text-xs">
                “Inconclusive” means the available evidence cannot establish a control outcome. It
                can follow an unfinished scan, an unassessed check, or a missing engine control
                mapping; it must not be read as a clean result.
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
                            <p className="text-muted-foreground mt-1 text-xs">{receipt.reason}</p>
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
    </>
  )
}

export function ScanFindingsSection({
  currentFindings,
  sortedFindings,
  scan,
  scorecard,
  hasLimitedCoverage,
  assuranceAvailable,
  isActive,
  expandedFindings,
  onToggleFinding,
}: {
  currentFindings: FindingItem[]
  sortedFindings: FindingItem[]
  scan: ScanData
  scorecard: CleanResultScorecard | null
  hasLimitedCoverage: boolean
  assuranceAvailable: boolean
  isActive: boolean
  expandedFindings: Set<string>
  onToggleFinding: (id: string) => void
}) {
  const severityCounts = currentFindings.reduce(
    (counts, finding) => {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1
      return counts
    },
    {} as Record<string, number>
  )

  return (
    <>
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
                    onClick={() => onToggleFinding(finding.id)}
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
                          {finding.verified && <span className="text-emerald-600">Verified</span>}
                          {!finding.verified && (
                            <span>{getVerificationStatusLabel(finding.verificationStatus)}</span>
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

      {currentFindings.length === 0 && !isActive && assuranceAvailable && (
        <div className="space-y-4">
          <EmptyState
            headingLevel="h3"
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
                    href={reportsHref({
                      scanId: scan.id,
                      ...(scan.target ? { targetId: scan.target.id } : {}),
                    })}
                    className={buttonVariants({ className: "mt-3" })}
                  >
                    Generate report
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                </div>
                {scorecard && (
                  <div className="min-w-0 border-t pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
                    <h2 className="font-semibold">Share this review</h2>
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
  )
}

export function ScanDetailHeader({
  scan,
  presentation,
  isActive,
  refreshError,
}: {
  scan: ScanData
  presentation: ScanPresentationResult
  isActive: boolean
  refreshError: boolean
}) {
  return (
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
  )
}

export function ScanEvidenceSummary({
  scan,
  isActive,
  nextAction,
  displayedCoverageState,
  coverageSummary,
  coverageWarningCount,
  refreshing,
  onRefresh,
}: {
  scan: ScanData
  isActive: boolean
  nextAction: ScanNextAction
  displayedCoverageState: string
  coverageSummary: string
  coverageWarningCount: number
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
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
              {displayedCoverageState === "Complete" ? (
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
          {coverageWarningCount > 0 && (
            <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-300">
              {coverageWarningCount} coverage limitation
              {coverageWarningCount === 1 ? "" : "s"} are listed below.
            </p>
          )}
        </div>
        {nextAction.kind === "refresh" ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 shrink-0"
            onClick={onRefresh}
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
  )
}

export function ScanRefreshPausedBanner({
  refreshing,
  onRetry,
}: {
  refreshing: boolean
  onRetry: () => void
}) {
  return (
    <div
      role="status"
      className="border-amber-500/50 bg-amber-500/10 mb-6 flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <span>Updates are paused. The displayed scan status may be stale.</span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={refreshing}>
        Try again
      </Button>
    </div>
  )
}

export function ScanCompletionNotice({
  notice,
  onDismiss,
}: {
  notice: CompletionNotice
  onDismiss: () => void
}) {
  // Presentational only — the always-mounted sr-only live region in the client
  // owns the announcement, so no role="status" here (that would make screen
  // readers read the completion twice).
  return (
    <div
      className={`mb-6 flex items-center gap-2 rounded-md border p-3 text-sm ${
        notice.status === "COMPLETED"
          ? "border-primary/30 bg-primary/5"
          : ["FAILED", "TIMED_OUT"].includes(notice.status)
            ? "border-destructive/50 bg-destructive/10"
            : "border-amber-500/50 bg-amber-500/10"
      }`}
    >
      {notice.status === "COMPLETED" ? (
        <CheckCircle2 className="text-primary h-4 w-4 shrink-0" aria-hidden="true" />
      ) : ["FAILED", "TIMED_OUT"].includes(notice.status) ? (
        <XCircle className="text-destructive h-4 w-4 shrink-0" aria-hidden="true" />
      ) : (
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 font-medium">{notice.message}</span>
      <Button size="sm" variant="ghost" className="shrink-0" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  )
}

export function ScanStatGrid({
  scan,
  findingsCount,
  verifiedCount,
  runCoverageState,
}: {
  scan: ScanData
  findingsCount: number
  verifiedCount: number
  runCoverageState: string
}) {
  return (
    <div
      id={scan.status === "COMPLETED" ? "scan-results-ready" : undefined}
      className="bg-border mb-6 grid gap-px border sm:grid-cols-2 lg:grid-cols-4"
    >
      <Card className="border-0 p-4 shadow-none">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4" aria-hidden="true" />
          Duration
        </div>
        <p className="mt-1 text-lg font-semibold">{formatDuration(scan.startedAt, scan.endedAt)}</p>
      </Card>
      <Card className="border-0 p-4 shadow-none">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <ShieldAlert className="h-4 w-4" aria-hidden="true" />
          Findings from this scan
        </div>
        <p className="mt-1 text-lg font-semibold">{findingsCount}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Retained after scanner layers and deduplication.
        </p>
      </Card>
      <Card className="border-0 p-4 shadow-none">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          Independently verified
        </div>
        <p className="mt-1 text-lg font-semibold">{verifiedCount}</p>
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
  )
}

/**
 * The whole terminal (non-active) layout: completion notice, stat grid,
 * evidence sections, coverage detail and findings. Rendered only once the
 * scan is no longer active.
 */
export function ScanTerminalView({
  scan,
  presentation,
  view,
  scorecard,
  completionNotice,
  onDismissNotice,
  expandedFindings,
  onToggleFinding,
}: {
  scan: ScanData
  presentation: ScanPresentationResult
  view: ScanDetailView
  scorecard: CleanResultScorecard | null
  completionNotice: CompletionNotice | null
  onDismissNotice: () => void
  expandedFindings: Set<string>
  onToggleFinding: (id: string) => void
}) {
  return (
    <>
      {completionNotice && (
        <ScanCompletionNotice notice={completionNotice} onDismiss={onDismissNotice} />
      )}
      <ScanStatGrid
        scan={scan}
        findingsCount={view.currentFindings.length}
        verifiedCount={view.currentFindings.filter((f) => f.verified).length}
        runCoverageState={view.runCoverageState}
      />

      <ScanEvidenceSections
        scan={scan}
        presentation={presentation}
        coverageWarnings={view.coverageWarnings}
        controlCoverage={view.controlCoverage}
        controlOutcomeCounts={view.controlOutcomeCounts}
      />

      {scan.aiSecurity && (
        <div className="mb-6">
          <AiSecurityScoreCard data={scan.aiSecurity} />
        </div>
      )}

      <ScanCoverageDetail
        scan={scan}
        familyCoverage={view.familyCoverage}
        controlCoverage={view.controlCoverage}
        incompleteCoverageCount={view.incompleteCoverage.length}
        controlOutcomeCounts={view.controlOutcomeCounts}
      />

      <ScanFindingsSection
        currentFindings={view.currentFindings}
        sortedFindings={view.sortedFindings}
        scan={scan}
        scorecard={scorecard}
        hasLimitedCoverage={view.hasLimitedCoverage}
        assuranceAvailable={presentation.assuranceAvailable}
        isActive={false}
        expandedFindings={expandedFindings}
        onToggleFinding={onToggleFinding}
      />
    </>
  )
}

export function ScanTechnicalDetails({ displayEvents }: { displayEvents: ScanData["events"] }) {
  const [expandedEvents, setExpandedEvents] = useState(false)
  const visibleEvents = expandedEvents ? displayEvents : displayEvents.slice(-10)
  return (
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
  )
}
