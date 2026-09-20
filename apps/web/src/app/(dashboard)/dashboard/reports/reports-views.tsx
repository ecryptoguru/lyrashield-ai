"use client"

import { useState } from "react"
import { FileText, Share2, Trash2, Copy, CheckCircle2, Download } from "lucide-react"
import {
  Button,
  Badge,
  buttonVariants,
  Card,
  EmptyState,
  Input,
  Select,
  FormField,
  Spinner,
} from "@lyrashield/ui"
import Link from "next/link"
import { writeClipboard } from "@/components/scorecard-share-composer"
import { LocalTime } from "@/components/local-time"
import { formatDateTime } from "@/lib/date-format"
import { gateReasonSentence } from "@/lib/launch-readiness"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { InlineConfirm } from "@/components/ui/inline-confirm"
import {
  LAUNCH_APPLICABILITY_LABEL,
  LAUNCH_HISTORICAL_VERDICT_LABEL,
  REPORT_TYPE_LABEL,
  type LaunchReportProvenance,
  type ReportItem,
} from "./reports-model"

/**
 * Private issue-time provenance for a launch_readiness report. This surface is
 * authenticated-only; the shared public page never receives these fields.
 */
export function LaunchReportProvenanceBlock({
  provenance,
}: {
  provenance: LaunchReportProvenance | null
}) {
  const [copiedIdentity, setCopiedIdentity] = useState(false)
  if (!provenance) {
    return (
      <p className="text-muted-foreground mt-2 text-xs">
        Release identity unavailable for this report.
      </p>
    )
  }
  const identity = provenance.assessedIdentity
  const identityLabel = identity
    ? identity.kind === "COMMIT"
      ? `commit ${identity.value}`
      : `artifact ${identity.value}`
    : null
  return (
    <dl className="text-muted-foreground mt-2 space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <dt className="font-medium">Assessed release:</dt>
        <dd>
          {identityLabel ? (
            <span className="inline-flex max-w-full items-center gap-1.5">
              <code className="break-all">{identityLabel}</code>
              <button
                type="button"
                aria-label="Copy assessed release identity"
                className="text-foreground/70 hover:text-foreground inline-flex items-center"
                onClick={() => {
                  if (!identity) return
                  void writeClipboard(identity.value)
                    .then(() => setCopiedIdentity(true))
                    .catch(() => {})
                }}
              >
                {copiedIdentity ? (
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            </span>
          ) : (
            "Not recorded in the retained assessment."
          )}
        </dd>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <div>
          <dt className="sr-only">Historical verdict</dt>
          <dd>
            Historical verdict:{" "}
            {LAUNCH_HISTORICAL_VERDICT_LABEL[provenance.historicalState] ??
              provenance.historicalState}
            {provenance.effectiveState && provenance.effectiveState !== provenance.historicalState
              ? ` · effective at issue: ${
                  LAUNCH_HISTORICAL_VERDICT_LABEL[provenance.effectiveState] ??
                  provenance.effectiveState
                }`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="sr-only">Applicability when issued</dt>
          <dd>Applicability when issued: {LAUNCH_APPLICABILITY_LABEL[provenance.applicability]}</dd>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <dd>Assessed {formatDateTime(provenance.assessedAt)} UTC</dd>
        <dd>Issued {formatDateTime(provenance.issuedAt)} UTC</dd>
        <dd>Applicability checked {formatDateTime(provenance.applicabilityCheckedAt)} UTC</dd>
      </div>
      {provenance.reasonCodes.length > 0 && (
        <dd>
          {provenance.reasonCodes
            .map((code) => gateReasonSentence({ code, message: "" }))
            .join(" ")}
        </dd>
      )}
    </dl>
  )
}

export type ReportType = "executive" | "developer" | "compliance"

export interface ReportScanOption {
  id: string
  targetName: string
  status: string
}

export function ReportCreateForm({
  reportType,
  onReportTypeChange,
  reportTitle,
  onTitleChange,
  scans,
  selectedScanId,
  onScanChange,
  creating,
  onCreate,
  onCancel,
}: {
  reportType: ReportType
  onReportTypeChange: (type: ReportType) => void
  reportTitle: string
  onTitleChange: (title: string) => void
  scans: ReportScanOption[]
  selectedScanId: string
  onScanChange: (scanId: string) => void
  creating: boolean
  onCreate: () => void
  onCancel: () => void
}) {
  return (
    <Card className="mb-5 p-5 sm:p-6">
      <div className="flex flex-col gap-5">
        <div>
          {/* Page-level section under the /dashboard/reports h1 — an h3 here skipped a level. */}
          <h2 className="font-semibold">Generate an assurance report</h2>
          <p className="text-muted-foreground mt-1 text-xs">
            Create an immutable, visual snapshot tailored to its reader and retained scan scope.
          </p>
        </div>
        <Tabs value={reportType} onValueChange={(value) => onReportTypeChange(value as ReportType)}>
          <TabsList className="h-12 w-full sm:w-fit">
            <TabsTrigger className="min-h-11 px-3" value="executive">
              Executive
            </TabsTrigger>
            <TabsTrigger className="min-h-11 px-3" value="developer">
              Developer
            </TabsTrigger>
            <TabsTrigger className="min-h-11 px-3" value="compliance">
              Assurance
            </TabsTrigger>
          </TabsList>
          <TabsContent value="executive" className="text-muted-foreground text-xs">
            Decision-first posture, score trajectory, release conditions and priority actions.
          </TabsContent>
          <TabsContent value="developer" className="text-muted-foreground text-xs">
            Technical findings, remediation state, retest outcomes and fix guidance.
          </TabsContent>
          <TabsContent value="compliance" className="text-muted-foreground text-xs">
            Evidence-oriented summary and methodology for lightweight assurance reviews.
          </TabsContent>
        </Tabs>
        <FormField label="Report title" htmlFor="report-title">
          <Input
            id="report-title"
            type="text"
            placeholder="Report title (optional)"
            value={reportTitle}
            onChange={(e) => onTitleChange(e.target.value)}
          />
        </FormField>
        {scans.length > 0 && (
          <FormField label="Scan" htmlFor="report-scan">
            <Select
              id="report-scan"
              value={selectedScanId}
              onChange={(e) => onScanChange(e.target.value)}
            >
              <option value="">Select a completed scan (optional)</option>
              {scans.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.targetName} — {s.status}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <div className="flex gap-2">
          <Button size="sm" disabled={creating} onClick={onCreate}>
            {creating ? <Spinner /> : "Create"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  )
}

export function ShareLinkCard({
  shareUrl,
  copied,
  handoffMessage,
  onCopyLink,
  onCopyHandoff,
}: {
  shareUrl: string
  copied: "link" | "handoff" | null
  handoffMessage: string
  onCopyLink: () => void
  onCopyHandoff: () => void
}) {
  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1" role="status">
          <p className="mb-1 text-sm font-medium">Share link generated (valid 30 days):</p>
          <p className="text-muted-foreground truncate font-mono text-sm">{shareUrl}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onCopyLink}>
            {copied === "link" ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {copied === "link" ? "Copied" : "Copy link"}
          </Button>
          <Button size="sm" variant="secondary" onClick={onCopyHandoff}>
            {copied === "handoff" ? "Handoff copied" : "Copy client handoff"}
          </Button>
          <a
            className="hover:bg-accent bg-card inline-flex h-11 items-center rounded-lg border px-3 text-xs font-medium"
            href={`mailto:?subject=${encodeURIComponent("Security scan ready")}&body=${encodeURIComponent(handoffMessage)}`}
          >
            Email client
          </a>
        </div>
      </div>
    </Card>
  )
}

export function ReportCard({
  report,
  workspaceId,
  onShare,
  onRevoke,
}: {
  report: ReportItem
  workspaceId: string
  onShare: (reportId: string) => void
  onRevoke: (reportId: string) => void
}) {
  return (
    <Card className="hover:shadow-card-hover p-4 transition-shadow duration-(--duration-base) ease-out">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <h2 className="truncate font-medium" title={report.title}>
              <a
                href={`/api/reports/${report.id}/download?workspaceId=${workspaceId}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`View ${report.title} in a new tab`}
                className="underline-offset-4 hover:underline"
              >
                {report.title}
              </a>
            </h2>
            <Badge variant="info">{REPORT_TYPE_LABEL[report.type] ?? report.type}</Badge>
            <Badge
              variant={
                report.status === "generated" || report.status === "downloaded"
                  ? "success"
                  : "muted"
              }
            >
              {report.status}
            </Badge>
            {report.revokedAt && <Badge variant="muted">revoked</Badge>}
          </div>
          <p className="text-muted-foreground text-sm">
            Created <LocalTime value={report.createdAt} />
            {report.shareExpiresAt && !report.revokedAt && (
              <>
                {" "}
                · Expires <LocalTime value={report.shareExpiresAt} />
              </>
            )}
          </p>
          {report.type === "launch_readiness" && (
            <LaunchReportProvenanceBlock provenance={report.provenance ?? null} />
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/reports/${report.id}/download?workspaceId=${workspaceId}&download=1`}
            download
            aria-label={`Download ${report.title}`}
            className={buttonVariants({ size: "sm", variant: "ghost" })}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </a>
          {!report.revokedAt && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={report.shareExpiresAt ? "Regenerate share link" : "Create share link"}
              onClick={() => onShare(report.id)}
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
          {!report.revokedAt && report.shareExpiresAt && (
            <InlineConfirm
              triggerIcon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
              aria-label="Revoke share link"
              message="Revoke link?"
              confirmLabel="Revoke"
              onConfirm={() => onRevoke(report.id)}
            />
          )}
        </div>
      </div>
    </Card>
  )
}

export function ReportsEmptyState() {
  return (
    <EmptyState
      icon={FileText}
      title="No reports yet"
      description="Generate a security report from a completed scan to share with stakeholders."
      action={
        <Link href="/dashboard/scans" className={buttonVariants()}>
          Start a scan
        </Link>
      }
    />
  )
}
