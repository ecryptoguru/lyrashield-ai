"use client"

import { useState, useEffect, useCallback } from "react"
import { FileText, Share2, Trash2, Copy, CheckCircle2, AlertCircle, Download, Plus } from "lucide-react"
import { Button, Badge, Card, EmptyState, Spinner, LoadMore, Input, Select, FormField } from "@lyrashield/ui"
import { apiGetPaginated, apiPost } from "@/lib/api-client"

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

export function ReportsClient({ workspaceId }: { workspaceId: string }) {
  const [reports, setReports] = useState<ReportItem[]>([])
  const [loading, setLoading] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
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
    let cancelled = false
    apiGetPaginated<ReportItem>(`/api/reports`, { workspaceId })
      .then((res) => {
        if (cancelled) return
        setReports(res.items)
        setNextCursor(res.nextCursor)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setReports([])
        setError("Failed to load reports. Please try again.")
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [workspaceId])

  const [showCreateForm, setShowCreateForm] = useState(false)
  const [reportTitle, setReportTitle] = useState("")
  const [creatingReport, setCreatingReport] = useState(false)
  const [scans, setScans] = useState<Array<{ id: string; targetName: string; status: string }>>([])
  const [selectedScanId, setSelectedScanId] = useState<string>("")

  useEffect(() => {
    let cancelled = false
    apiGetPaginated<{ id: string; target: { name: string }; status: string }>(`/api/scans`, { workspaceId })
      .then((res) => {
        if (cancelled) return
        setScans(res.items.map((s) => ({ id: s.id, targetName: s.target.name, status: s.status })))
      })
      .catch(() => {
        // scans optional — ignore errors
      })
    return () => { cancelled = true }
  }, [workspaceId])

  const handleCreateReport = async () => {
    setCreatingReport(true)
    setError(null)
    try {
      await apiPost(`/api/reports`, {
        workspaceId,
        title: reportTitle || "Security Report",
        ...(selectedScanId ? { scanId: selectedScanId } : {}),
      })
      setShowCreateForm(false)
      setReportTitle("")
      setSelectedScanId("")
      await loadReports()
    } catch {
      setError("Failed to create report.")
    } finally {
      setCreatingReport(false)
    }
  }

  const handleShare = async (reportId: string) => {
    try {
      const res = await apiPost<{ token: string; shareUrl: string }>(
        `/api/reports/${reportId}`,
        { workspaceId, action: "share" }
      )
      const fullUrl = `${window.location.origin}${res.shareUrl}`
      setShareUrl(fullUrl)
      setCopied(false)
      setReports((prev) =>
        prev.map((r) =>
          r.id === reportId
            ? { ...r, shareTokenHash: "active", shareExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }
            : r
        )
      )
    } catch {
      setError("Failed to generate share link.")
    }
  }

  const handleRevoke = async (reportId: string) => {
    try {
      await apiPost(`/api/reports/${reportId}`, { workspaceId, action: "revoke" })
      setReports((prev) =>
        prev.map((r) => (r.id === reportId ? { ...r, revokedAt: new Date().toISOString() } : r))
      )
    } catch {
      setError("Failed to revoke share link.")
    }
  }

  const copyToClipboard = () => {
    if (shareUrl) {
      void navigator.clipboard.writeText(shareUrl)
      setCopied(true)
    }
  }

  if (loading && reports.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12" aria-busy="true">
        <Spinner className="h-6 w-6" />
        <p className="text-sm text-muted-foreground">Loading reports...</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">Generate and share security reports with stakeholders</p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowCreateForm(!showCreateForm)}
        >
          <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
          Generate Report
        </Button>
      </div>

      {showCreateForm && (
        <Card className="mb-4 p-4">
          <div className="space-y-3">
            <h3 className="text-sm font-medium">Generate New Report</h3>
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
                  <option value="">Select a scan (optional)</option>
                  {scans.map((s) => (
                    <option key={s.id} value={s.id}>{s.targetName} — {s.status}</option>
                  ))}
                </Select>
              </FormField>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={creatingReport}
                onClick={() => void handleCreateReport()}
              >
                {creatingReport ? <Spinner /> : "Create"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { setShowCreateForm(false); setReportTitle(""); setSelectedScanId("") }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {error && (
        <Card className="mb-4 p-4 border-destructive/50">
          <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { setError(null); void loadReports() }}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {shareUrl && (
        <Card className="mb-4 p-4">
          <div className="flex items-center justify-between gap-4" role="status">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">Share link generated (valid 30 days):</p>
              <p className="text-sm text-muted-foreground truncate font-mono">{shareUrl}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={copyToClipboard}>
              {copied ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Card>
      )}

      {reports.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No reports yet"
          description="Generate a security report from a completed scan to share with stakeholders."
        />
      ) : (
        <div className="space-y-3">
          {reports.map((report) => (
            <Card key={report.id} className="p-4 transition-shadow duration-200 hover:shadow-card-hover">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium truncate">{report.title}</h3>
                    <Badge variant="info">{report.type}</Badge>
                    <Badge variant={report.status === "generated" || report.status === "downloaded" ? "success" : "muted"}>
                      {report.status}
                    </Badge>
                    {report.revokedAt && (
                      <Badge variant="muted">revoked</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Created {new Date(report.createdAt).toLocaleDateString()}
                    {report.shareExpiresAt && !report.revokedAt && (
                      <> · Expires {new Date(report.shareExpiresAt).toLocaleDateString()}</>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Download report"
                    onClick={() => {
                      window.open(`/api/reports/${report.id}/download?workspaceId=${workspaceId}`, "_blank")
                    }}
                  >
                    <Download className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  {!report.revokedAt && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={report.shareTokenHash ? "Regenerate share link" : "Create share link"}
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
              const res = await apiGetPaginated<ReportItem>(
                `/api/reports`, { workspaceId, cursor }
              )
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
