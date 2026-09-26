"use client"

import { useState, useEffect, useCallback } from "react"
import { Plus } from "lucide-react"
import { Button, LoadMore } from "@lyrashield/ui"
import { Skeleton } from "@/components/ui/skeleton"
import { apiGet, apiGetPaginated, apiPost } from "@/lib/api-client"
import { writeClipboard } from "@/components/scorecard-share-composer"
import { DashboardErrorCard } from "@/components/dashboard-error-card"
import { track } from "@/lib/analytics"
import {
  reportScansPaginatedSchema,
  reportScanSchema,
  reportShareSchema,
  reportRevokeSchema,
  reportsPaginatedSchema,
  type ReportItem,
} from "./reports-model"
import {
  ReportCard,
  ReportCreateForm,
  ReportsEmptyState,
  ShareLinkCard,
  type ReportScanOption,
  type ReportType,
} from "./reports-views"
import { useReportsWebMcp } from "./reports-webmcp"

export function ReportsClient({
  workspaceId,
  initialScanId,
  initialTargetId,
}: {
  workspaceId: string
  initialScanId?: string
  initialTargetId?: string
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
      const res = await apiGetPaginated<ReportItem>(
        `/api/reports`,
        { workspaceId },
        { schema: reportsPaginatedSchema }
      )
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

  // Page-scoped agent read: `review_scan_report` resolves report ids against
  // the page's own visible list; the workspace is bound at registration.
  useReportsWebMcp({ workspaceId, reports })

  const [showCreateForm, setShowCreateForm] = useState(Boolean(initialScanId))
  const [reportTitle, setReportTitle] = useState("")
  const [creatingReport, setCreatingReport] = useState(false)
  const [scans, setScans] = useState<ReportScanOption[]>([])
  const [selectedScanId, setSelectedScanId] = useState<string>(initialScanId ?? "")
  const [reportType, setReportType] = useState<ReportType>("executive")

  useEffect(() => {
    let cancelled = false
    async function loadCompletedScans() {
      try {
        const params: Record<string, string> = { workspaceId, status: "COMPLETED" }
        if (initialTargetId) {
          params.targetId = initialTargetId
        }
        const res = await apiGetPaginated<{
          id: string
          target: { name: string }
          status: string
        }>(`/api/scans`, params, { schema: reportScansPaginatedSchema })
        const completedScans = res.items
        let linkedScanAvailable =
          !initialScanId || completedScans.some((scan) => scan.id === initialScanId)

        if (initialScanId && !linkedScanAvailable) {
          try {
            const linkedScan = await apiGet<{
              id: string
              target: { name: string }
              status: string
            }>(`/api/scans/${initialScanId}?workspaceId=${encodeURIComponent(workspaceId)}`, {
              schema: reportScanSchema,
            })
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
        // Pre-select the latest completed scan for the requested target when no
        // explicit scan was supplied.
        else if (initialTargetId && !initialScanId && completedScans.length > 0) {
          const first = completedScans[0]
          if (first) setSelectedScanId(first.id)
        }
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
  }, [workspaceId, initialScanId, initialTargetId])

  const resetCreateForm = () => {
    setShowCreateForm(false)
    setReportTitle("")
    setSelectedScanId("")
    setReportType("executive")
  }

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
      track("report_created", { report_kind: reportType })
      resetCreateForm()
      await loadReports()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create report.")
    } finally {
      setCreatingReport(false)
    }
  }

  const handleShare = async (reportId: string) => {
    try {
      const res = await apiPost(
        `/api/reports/${reportId}`,
        { workspaceId, action: "share" },
        { schema: reportShareSchema }
      )
      const fullUrl = `${window.location.origin}${res.shareUrl}`
      setShareUrl(fullUrl)
      setSharedReportId(reportId)
      setCopied(null)
      setReports((prev) =>
        prev.map((r) =>
          r.id === reportId
            ? {
                ...r,
                // shareExpiresAt (not the server-held shareTokenHash) marks the
                // report as actively shared — the share response no longer
                // echoes the hash back to the client.
                shareExpiresAt: res.expiresAt,
              }
            : r
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate share link.")
    }
  }

  const handleRevoke = async (reportId: string) => {
    try {
      const result = await apiPost(
        `/api/reports/${reportId}`,
        { workspaceId, action: "revoke" },
        { schema: reportRevokeSchema }
      )
      setReports((prev) =>
        prev.map((r) => (r.id === reportId ? { ...r, revokedAt: result.revokedAt } : r))
      )
      if (sharedReportId === reportId) {
        setShareUrl(null)
        setSharedReportId(null)
        setCopied(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke share link.")
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
    ? `Security scan ready for your review. This private link expires in 30 days: ${shareUrl}`
    : ""

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button
          className="self-start sm:self-auto"
          onClick={() => setShowCreateForm(!showCreateForm)}
        >
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Generate Report
        </Button>
      </div>

      {showCreateForm && (
        <ReportCreateForm
          reportType={reportType}
          onReportTypeChange={setReportType}
          reportTitle={reportTitle}
          onTitleChange={setReportTitle}
          scans={scans}
          selectedScanId={selectedScanId}
          onScanChange={setSelectedScanId}
          creating={creatingReport}
          onCreate={() => void handleCreateReport()}
          onCancel={resetCreateForm}
        />
      )}

      {error && (
        <DashboardErrorCard
          message={error}
          onRetry={() => {
            setError(null)
            void loadReports()
          }}
        />
      )}

      {shareUrl && (
        <ShareLinkCard
          shareUrl={shareUrl}
          copied={copied}
          handoffMessage={handoffMessage}
          onCopyLink={() => void copyToClipboard()}
          onCopyHandoff={() => {
            void writeClipboard(handoffMessage)
              .then(() => setCopied("handoff"))
              .catch(() => setError("Failed to copy client handoff."))
          }}
        />
      )}

      {loading && reports.length === 0 ? (
        <div
          className="space-y-3"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="Loading reports"
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-24 w-full" />
          ))}
        </div>
      ) : reports.length === 0 ? (
        <ReportsEmptyState />
      ) : (
        <div className="space-y-3">
          {reports.map((report) => (
            <ReportCard
              key={report.id}
              report={report}
              workspaceId={workspaceId}
              onShare={(reportId) => void handleShare(reportId)}
              onRevoke={(reportId) => void handleRevoke(reportId)}
            />
          ))}

          <LoadMore
            cursor={nextCursor}
            onLoadMore={async (cursor) => {
              const res = await apiGetPaginated<ReportItem>(
                `/api/reports`,
                { workspaceId, cursor },
                { schema: reportsPaginatedSchema }
              )
              return { items: res.items, nextCursor: res.nextCursor }
            }}
            onItems={(items) => setReports((prev) => [...prev, ...items])}
            onNextCursor={setNextCursor}
          />
        </div>
      )}
    </div>
  )
}
