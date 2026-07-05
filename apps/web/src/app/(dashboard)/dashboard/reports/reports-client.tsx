"use client"

import { useState, useEffect, useCallback } from "react"
import { FileText, Share2, Trash2, Copy, CheckCircle2, AlertCircle } from "lucide-react"
import { Button, Badge, Card, EmptyState, Spinner, LoadMore } from "@lyrashield/ui"
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
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Reports</h1>
      </div>

      {error && (
        <Card className="mb-4 p-4 border-destructive/50">
          <div className="flex items-center gap-2 text-sm text-destructive">
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
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium mb-1">Share link generated (valid 30 days):</p>
              <p className="text-sm text-muted-foreground truncate font-mono">{shareUrl}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={copyToClipboard}>
              {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
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
            <Card key={report.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-medium truncate">{report.title}</h3>
                    <Badge variant="info">{report.type}</Badge>
                    <Badge variant={report.status === "generated" ? "success" : "muted"}>
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
                  {!report.revokedAt && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={report.shareTokenHash ? "Regenerate share link" : "Create share link"}
                      onClick={() => void handleShare(report.id)}
                    >
                      <Share2 className="h-4 w-4" />
                    </Button>
                  )}
                  {!report.revokedAt && report.shareTokenHash && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Revoke share link"
                      onClick={() => void handleRevoke(report.id)}
                    >
                      <Trash2 className="h-4 w-4" />
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
