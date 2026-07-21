"use client"

import { useState, useEffect, useCallback } from "react"
import {
  FileText,
  Share2,
  Trash2,
  Copy,
  CheckCircle2,
  AlertCircle,
  Download,
  Plus,
} from "lucide-react"
import {
  Button,
  Badge,
  Card,
  EmptyState,
  Spinner,
  LoadMore,
  Input,
  Select,
  FormField,
} from "@lyrashield/ui"
import { apiGet, apiGetPaginated, apiPost } from "@/lib/api-client"
import { writeClipboard } from "@/components/scorecard-share-composer"
import { formatDate } from "@/lib/date-format"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"

interface ReportItem {
  id: string
  title: string
  type: string
  status: string
  format: string
  shareTokenHash: string | null
  shareExpiresAt: string | null
  revokedAt: string | null
  createdAt: string
  scanId: string | null
}

export function ReportsClient({
  workspaceId,
  initialScanId,
}: {
  workspaceId: string
  initialScanId?: string
}) {
  const [reports, setReports] = useState<ReportItem[]>([])
  const [loading, setLoading] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [sharedReportId, setSharedReportId] = useState<string | null>(null)
  const [copied, setCopied] = useState<"link" | "handoff" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadReports = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiGetPaginated<ReportItem>(`/api/reports`, { workspaceId })
      setReports(res.items)
      setNextCursor(res.nextCursor)
      setError(null)
    } catch {
      setReports([])
      setError("Failed to load reports. Please try again.")
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch, setState runs in promise callback
    void loadReports()
  }, [loadReports])

  const [showCreateForm, setShowCreateForm] = useState(Boolean(initialScanId))
  const [reportTitle, setReportTitle] = useState("")
  const [creatingReport, setCreatingReport] = useState(false)
  const [scans, setScans] = useState<Array<{ id: string; targetName: string; status: string }>>([])
  const [selectedScanId, setSelectedScanId] = useState<string>(initialScanId ?? "")
  const [reportType, setReportType] = useState<"executive" | "developer" | "compliance">(
    "executive"
  )

  useEffect(() => {
    let cancelled = false
    async function loadCompletedScans() {
      try {
        const res = await apiGetPaginated<{
          id: string
          target: { name: string }
          status: string
        }>(`/api/scans`, { workspaceId, status: "COMPLETED" })
        const completedScans = res.items
        let linkedScanAvailable =
          !initialScanId || completedScans.some((scan) => scan.id === initialScanId)

        if (initialScanId && !linkedScanAvailable) {
          try {
            const linkedScan = await apiGet<{
              id: string
              target: { name: string }
              status: string
            }>(`/api/scans/${initialScanId}?workspaceId=${encodeURIComponent(workspaceId)}`)
            if (linkedScan.status === "COMPLETED") {
              completedScans.unshift(linkedScan)
              linkedScanAvailable = true
            }
          } catch {
            // The report form remains usable if the linked scan is unavailable.
          }
        }

        if (cancelled) return
        if (!linkedScanAvailable) setSelectedScanId("")
        setScans(
          completedScans.map((scan) => ({
            id: scan.id,
            targetName: scan.target.name,
            status: scan.status,
          }))
        )
      } catch {
        // scans optional — ignore errors
      }
    }
    void loadCompletedScans()
    return () => {
      cancelled = true
    }
  }, [workspaceId, initialScanId])

  const handleCreateReport = async () => {
    setCreatingReport(true)
    setError(null)
    try {
      await apiPost(`/api/reports`, {
        workspaceId,
        title: reportTitle || "Security Report",
        type: reportType,
        ...(selectedScanId ? { scanId: selectedScanId } : {}),
      })
      setShowCreateForm(false)
      setReportTitle("")
      setSelectedScanId("")
      setReportType("executive")
      await loadReports()
    } catch {
      setError("Failed to create report.")
    } finally {
      setCreatingReport(false)
    }
  }

  const handleShare = async (reportId: string) => {
    try {
      const res = await apiPost<{
        token: string
        tokenHash: string
        expiresAt: string
        shareUrl: string
      }>(`/api/reports/${reportId}`, { workspaceId, action: "share" })
      const fullUrl = `${window.location.origin}${res.shareUrl}`
      setShareUrl(fullUrl)
      setSharedReportId(reportId)
      setCopied(null)
      setReports((prev) =>
        prev.map((r) =>
          r.id === reportId
            ? {
                ...r,
                shareTokenHash: res.tokenHash,
                shareExpiresAt: res.expiresAt,
              }
            : r
        )
      )
    } catch {
      setError("Failed to generate share link.")
    }
  }

  const handleRevoke = async (reportId: string) => {
    if (!window.confirm("Revoke this report link? Anyone using it will immediately lose access.")) {
      return
    }
    try {
      const result = await apiPost<{ revoked: true; revokedAt: string }>(
        `/api/reports/${reportId}`,
        { workspaceId, action: "revoke" }
      )
      setReports((prev) =>
        prev.map((r) => (r.id === reportId ? { ...r, revokedAt: result.revokedAt } : r))
      )
      if (sharedReportId === reportId) {
        setShareUrl(null)
        setSharedReportId(null)
        setCopied(null)
      }
    } catch {
      setError("Failed to revoke share link.")
    }
  }

  const copyToClipboard = async () => {
    if (shareUrl) {
      try {
        await writeClipboard(shareUrl)
        setCopied("link")
      } catch {
        setError("Failed to copy share link.")
      }
    }
  }

  const handoffMessage = shareUrl
    ? `Security review ready for your review. This private link expires in 30 days: ${shareUrl}`
    : ""

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Create immutable assurance snapshots from completed scan evidence
          </p>
        </div>
        <Button
          className="self-start sm:self-auto"
          onClick={() => setShowCreateForm(!showCreateForm)}
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Generate Report
        </Button>
      </div>

      {showCreateForm && (
        <Card className="mb-5 p-5 sm:p-6">
          <div className="flex flex-col gap-5">
            <div>
              <h3 className="font-semibold">Generate an assurance report</h3>
              <p className="text-muted-foreground mt-1 text-xs">
                Create an immutable, visual snapshot tailored to its reader and retained scan scope.
              </p>
            </div>
            <Tabs
              value={reportType}
              onValueChange={(value) =>
                setReportType(value as "executive" | "developer" | "compliance")
              }
            >
              <TabsList className="h-12 w-full sm:w-fit">
                <TabsTrigger className="min-h-11 px-3" value="executive">
                  Executive
                </TabsTrigger>
                <TabsTrigger className="min-h-11 px-3" value="developer">
                  Developer
                </TabsTrigger>
                <TabsTrigger className="min-h-11 px-3" value="compliance">
                  Compliance
                </TabsTrigger>
              </TabsList>
              <TabsContent value="executive" className="text-muted-foreground text-xs">
                Decision-first posture, score trajectory, release conditions, and priority actions.
              </TabsContent>
              <TabsContent value="developer" className="text-muted-foreground text-xs">
                Technical findings, remediation state, retest outcomes, and fix guidance.
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
                onChange={(e) => setReportTitle(e.target.value)}
              />
            </FormField>
            {scans.length > 0 && (
              <FormField label="Scan" htmlFor="report-scan">
                <Select
                  id="report-scan"
                  value={selectedScanId}
                  onChange={(e) => setSelectedScanId(e.target.value)}
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
              <Button size="sm" disabled={creatingReport} onClick={() => void handleCreateReport()}>
                {creatingReport ? <Spinner /> : "Create"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowCreateForm(false)
                  setReportTitle("")
                  setSelectedScanId("")
                  setReportType("executive")
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {error && (
        <Card className="border-destructive/50 mb-4 p-4">
          <div className="text-destructive flex items-center gap-2 text-sm" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setError(null)
                void loadReports()
              }}
            >
              Retry
            </Button>
          </div>
        </Card>
      )}

      {shareUrl && (
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 flex-1" role="status">
              <p className="mb-1 text-sm font-medium">Share link generated (valid 30 days):</p>
              <p className="text-muted-foreground truncate font-mono text-sm">{shareUrl}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copyToClipboard()}>
                {copied === "link" ? (
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                {copied === "link" ? "Copied" : "Copy link"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void writeClipboard(handoffMessage)
                    .then(() => setCopied("handoff"))
                    .catch(() => setError("Failed to copy client handoff."))
                }}
              >
                {copied === "handoff" ? "Handoff copied" : "Copy client handoff"}
              </Button>
              <a
                className="hover:bg-accent bg-card inline-flex h-11 items-center rounded-lg border px-3 text-xs font-medium"
                href={`mailto:?subject=${encodeURIComponent("Security review ready")}&body=${encodeURIComponent(handoffMessage)}`}
              >
                Email client
              </a>
            </div>
          </div>
        </Card>
      )}

      {loading && reports.length === 0 ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading reports">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-24 w-full" />
          ))}
        </div>
      ) : reports.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No reports yet"
          description="Generate a security report from a completed scan to share with stakeholders."
        />
      ) : (
        <div className="space-y-3">
          {reports.map((report) => (
            <Card
              key={report.id}
              className="hover:shadow-card-hover p-4 transition-shadow duration-200"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <h3 className="truncate font-medium" title={report.title}>
                      {report.title}
                    </h3>
                    <Badge variant="info">{report.type}</Badge>
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
                    Created {formatDate(report.createdAt)}
                    {report.shareExpiresAt && !report.revokedAt && (
                      <> · Expires {formatDate(report.shareExpiresAt)}</>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Download report"
                    onClick={() => {
                      window.open(
                        `/api/reports/${report.id}/download?workspaceId=${workspaceId}`,
                        "_blank"
                      )
                    }}
                  >
                    <Download className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  {!report.revokedAt && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={
                        report.shareTokenHash ? "Regenerate share link" : "Create share link"
                      }
                      onClick={() => void handleShare(report.id)}
                    >
                      <Share2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                  {!report.revokedAt && report.shareTokenHash && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Revoke share link"
                      onClick={() => void handleRevoke(report.id)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}

          <LoadMore
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const res = await apiGetPaginated<ReportItem>(`/api/reports`, { workspaceId, cursor })
              return { items: res.items as unknown[], nextCursor: res.nextCursor }
            }}
            onItems={(items) => setReports((prev) => [...prev, ...(items as ReportItem[])])}
            onNextCursor={setNextCursor}
          />
        </div>
      )}
    </div>
  )
}
