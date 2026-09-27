"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Plus } from "lucide-react"
import { Button, Spinner } from "@lyrashield/ui"
import { Skeleton } from "@/components/ui/skeleton"
import { apiGet, apiGetPaginated, apiPost, ApiError } from "@/lib/api-client"
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

type ReportCreationScope = { kind: "workspace" } | { kind: "scan"; scanId: string }
type ReadFailure = { kind: "denied" | "failed"; message: string }

function readFailure(error: unknown, fallback: string): ReadFailure {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return { kind: "denied", message: "Access to this workspace data was denied." }
  }
  return { kind: "failed", message: fallback }
}

function scopeValue(scope: ReportCreationScope): string {
  return scope.kind === "workspace" ? "workspace" : `scan:${scope.scanId}`
}

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
  const [loadingReports, setLoadingReports] = useState(true)
  const [reportsError, setReportsError] = useState<ReadFailure | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMoreReports, setLoadingMoreReports] = useState(false)
  const [reportsPageError, setReportsPageError] = useState<string | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [sharedReportId, setSharedReportId] = useState<string | null>(null)
  const [copied, setCopied] = useState<"link" | "handoff" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [showCreateForm, setShowCreateForm] = useState(Boolean(initialScanId))
  const [reportTitle, setReportTitle] = useState("")
  const [creatingReport, setCreatingReport] = useState(false)
  const [creationScope, setCreationScope] = useState<ReportCreationScope>(
    initialScanId ? { kind: "scan", scanId: initialScanId } : { kind: "workspace" }
  )
  const [reportType, setReportType] = useState<ReportType>("executive")
  const [scans, setScans] = useState<ReportScanOption[]>([])
  const [scanCursor, setScanCursor] = useState<string | null>(null)
  const [loadingScans, setLoadingScans] = useState(true)
  const [scansError, setScansError] = useState<ReadFailure | null>(null)
  const [scanPageError, setScanPageError] = useState<string | null>(null)
  const [loadingMoreScans, setLoadingMoreScans] = useState(false)
  const [linkedScanAvailable, setLinkedScanAvailable] = useState(!initialScanId)

  const mountedRef = useRef(false)
  const workspaceRef = useRef(workspaceId)
  const pickerScopeKey = `${workspaceId}:${initialScanId ?? ""}:${initialTargetId ?? ""}`
  const pickerScopeRef = useRef(pickerScopeKey)
  const creationScopeKey = `${workspaceId}:${scopeValue(creationScope)}`
  const creationScopeRef = useRef(creationScopeKey)
  const reportsRequestRef = useRef(0)
  const reportsPageRequestRef = useRef(0)
  const scansRequestRef = useRef(0)
  const scansPageRequestRef = useRef(0)
  const createRequestsRef = useRef(new Set<string>())
  const reportMutationVersionsRef = useRef(new Map<string, number>())

  const isWorkspaceCurrent = useCallback(
    (requestWorkspaceId: string) =>
      mountedRef.current && workspaceRef.current === requestWorkspaceId,
    []
  )
  const isPickerScopeCurrent = useCallback(
    (requestScopeKey: string) => mountedRef.current && pickerScopeRef.current === requestScopeKey,
    []
  )
  const isCreationScopeCurrent = useCallback(
    (requestScopeKey: string) => mountedRef.current && creationScopeRef.current === requestScopeKey,
    []
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      reportsRequestRef.current += 1
      reportsPageRequestRef.current += 1
      scansRequestRef.current += 1
      scansPageRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    workspaceRef.current = workspaceId
    pickerScopeRef.current = pickerScopeKey
    creationScopeRef.current = creationScopeKey
  }, [creationScopeKey, pickerScopeKey, workspaceId])

  const updateCreationScope = (scope: ReportCreationScope) => {
    creationScopeRef.current = `${workspaceId}:${scopeValue(scope)}`
    setCreationScope(scope)
  }

  const loadReports = useCallback(async () => {
    const requestId = ++reportsRequestRef.current
    reportsPageRequestRef.current += 1
    setLoadingReports(true)
    setLoadingMoreReports(false)
    setReportsError(null)
    setReportsPageError(null)
    try {
      const res = await apiGetPaginated<ReportItem>(
        "/api/reports",
        { workspaceId },
        { schema: reportsPaginatedSchema }
      )
      if (!isWorkspaceCurrent(workspaceId) || reportsRequestRef.current !== requestId) return
      setReports(res.items)
      setNextCursor(res.nextCursor)
    } catch (error) {
      if (!isWorkspaceCurrent(workspaceId) || reportsRequestRef.current !== requestId) return
      setReports([])
      setNextCursor(null)
      setReportsError(readFailure(error, "Failed to load reports. Please try again."))
    } finally {
      if (isWorkspaceCurrent(workspaceId) && reportsRequestRef.current === requestId) {
        setLoadingReports(false)
      }
    }
  }, [isWorkspaceCurrent, workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch, setState runs in promise callback
    void loadReports()
  }, [loadReports])

  // Page-scoped agent read: `review_scan_report` resolves report ids against
  // the page's workspace-wide visible history.
  useReportsWebMcp({ workspaceId, reports })

  const loadScans = useCallback(async () => {
    const requestId = ++scansRequestRef.current
    scansPageRequestRef.current += 1
    const requestScope = pickerScopeKey
    setLoadingScans(true)
    setLoadingMoreScans(false)
    setScansError(null)
    setScanPageError(null)

    let availableScans: Array<{ id: string; target: { name: string }; status: string }> = []
    let cursor: string | null = null
    let listFailure: ReadFailure | null = null
    try {
      const params: Record<string, string> = { workspaceId, status: "COMPLETED" }
      if (initialTargetId) params.targetId = initialTargetId
      const res = await apiGetPaginated<{
        id: string
        target: { name: string }
        status: string
      }>("/api/scans", params, { schema: reportScansPaginatedSchema })
      availableScans = res.items
      cursor = res.nextCursor
    } catch (error) {
      listFailure = readFailure(error, "Failed to load completed scans.")
    }

    if (!isPickerScopeCurrent(requestScope) || scansRequestRef.current !== requestId) return
    let linkedScanFound = !initialScanId
    if (initialScanId && !availableScans.some((scan) => scan.id === initialScanId)) {
      try {
        const linkedScan = await apiGet<{
          id: string
          target: { name: string }
          status: string
        }>(`/api/scans/${initialScanId}?workspaceId=${encodeURIComponent(workspaceId)}`, {
          schema: reportScanSchema,
        })
        if (linkedScan.status === "COMPLETED") {
          availableScans.unshift(linkedScan)
          linkedScanFound = true
        }
      } catch {
        // An unavailable linked scan stays selected and blocks creation.
      }
    } else if (initialScanId) {
      linkedScanFound = true
    }

    if (!isPickerScopeCurrent(requestScope) || scansRequestRef.current !== requestId) return
    setScans(
      availableScans.map((scan) => ({
        id: scan.id,
        targetName: scan.target.name,
        status: scan.status,
      }))
    )
    setScanCursor(cursor)
    setScansError(listFailure)
    setLinkedScanAvailable(linkedScanFound)
    setLoadingScans(false)
  }, [initialScanId, initialTargetId, isPickerScopeCurrent, pickerScopeKey, workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch, setState runs in promise callback
    void loadScans()
  }, [loadScans])

  const loadMoreScans = async () => {
    if (!scanCursor || loadingMoreScans) return
    const requestScope = pickerScopeKey
    const requestId = ++scansPageRequestRef.current
    const cursor = scanCursor
    setLoadingMoreScans(true)
    setScanPageError(null)
    try {
      const params: Record<string, string> = { workspaceId, status: "COMPLETED", cursor }
      if (initialTargetId) params.targetId = initialTargetId
      const res = await apiGetPaginated<{
        id: string
        target: { name: string }
        status: string
      }>("/api/scans", params, { schema: reportScansPaginatedSchema })
      if (!isPickerScopeCurrent(requestScope) || scansPageRequestRef.current !== requestId) return
      setScans((current) => {
        const knownIds = new Set(current.map((scan) => scan.id))
        return [
          ...current,
          ...res.items
            .filter((scan) => !knownIds.has(scan.id))
            .map((scan) => ({
              id: scan.id,
              targetName: scan.target.name,
              status: scan.status,
            })),
        ]
      })
      setScanCursor(res.nextCursor)
    } catch (error) {
      if (!isPickerScopeCurrent(requestScope) || scansPageRequestRef.current !== requestId) return
      const failure = readFailure(error, "Failed to load more completed scans.")
      setScanPageError(failure.message)
    } finally {
      if (isPickerScopeCurrent(requestScope) && scansPageRequestRef.current === requestId) {
        setLoadingMoreScans(false)
      }
    }
  }

  const resetCreateForm = () => {
    setShowCreateForm(false)
    setReportTitle("")
    setCreatingReport(false)
    updateCreationScope({ kind: "workspace" })
    setReportType("executive")
    setActionError(null)
  }

  const onScopeChange = (value: string) => {
    if (value === "workspace") {
      updateCreationScope({ kind: "workspace" })
    } else if (value.startsWith("scan:") && value.length > 5) {
      updateCreationScope({ kind: "scan", scanId: value.slice(5) })
    }
    setActionError(null)
  }

  const selectedScanId = creationScope.kind === "scan" ? creationScope.scanId : null
  const selectedScanAvailable =
    selectedScanId !== null && scans.some((scan) => scan.id === selectedScanId)
  const linkedScanUnavailable =
    selectedScanId !== null &&
    selectedScanId === initialScanId &&
    !loadingScans &&
    !linkedScanAvailable
  const canCreate = creationScope.kind === "workspace" || selectedScanAvailable

  const handleCreateReport = async () => {
    const requestScope = creationScopeKey
    if (!canCreate || createRequestsRef.current.has(requestScope)) return
    createRequestsRef.current.add(requestScope)
    setCreatingReport(true)
    setActionError(null)
    try {
      await apiPost("/api/reports", {
        workspaceId,
        title: reportTitle || "Security Report",
        type: reportType,
        ...(creationScope.kind === "scan" ? { scanId: creationScope.scanId } : {}),
      })
      if (!isCreationScopeCurrent(requestScope)) return
      track("report_created", { report_kind: reportType })
      resetCreateForm()
      await loadReports()
    } catch (error) {
      if (isCreationScopeCurrent(requestScope)) {
        setActionError(error instanceof Error ? error.message : "Failed to create report.")
      }
    } finally {
      createRequestsRef.current.delete(requestScope)
      if (isCreationScopeCurrent(requestScope)) setCreatingReport(false)
    }
  }

  const handleShare = async (reportId: string) => {
    const mutationKey = `${workspaceId}:${reportId}`
    const mutationVersion = (reportMutationVersionsRef.current.get(mutationKey) ?? 0) + 1
    reportMutationVersionsRef.current.set(mutationKey, mutationVersion)
    try {
      const res = await apiPost(
        `/api/reports/${reportId}`,
        { workspaceId, action: "share" },
        { schema: reportShareSchema }
      )
      if (
        !isWorkspaceCurrent(workspaceId) ||
        reportMutationVersionsRef.current.get(mutationKey) !== mutationVersion
      ) {
        return
      }
      const fullUrl = `${window.location.origin}${res.shareUrl}`
      setShareUrl(fullUrl)
      setSharedReportId(reportId)
      setCopied(null)
      setActionError(null)
      setReports((current) =>
        current.map((report) =>
          report.id === reportId ? { ...report, shareExpiresAt: res.expiresAt } : report
        )
      )
    } catch (error) {
      if (isWorkspaceCurrent(workspaceId)) {
        setActionError(error instanceof Error ? error.message : "Failed to generate share link.")
      }
    }
  }

  const handleRevoke = async (reportId: string) => {
    const mutationKey = `${workspaceId}:${reportId}`
    const mutationVersion = (reportMutationVersionsRef.current.get(mutationKey) ?? 0) + 1
    reportMutationVersionsRef.current.set(mutationKey, mutationVersion)
    try {
      const result = await apiPost(
        `/api/reports/${reportId}`,
        { workspaceId, action: "revoke" },
        { schema: reportRevokeSchema }
      )
      if (
        !isWorkspaceCurrent(workspaceId) ||
        reportMutationVersionsRef.current.get(mutationKey) !== mutationVersion
      ) {
        return
      }
      setReports((current) =>
        current.map((report) =>
          report.id === reportId ? { ...report, revokedAt: result.revokedAt } : report
        )
      )
      if (sharedReportId === reportId) {
        setShareUrl(null)
        setSharedReportId(null)
        setCopied(null)
      }
      setActionError(null)
    } catch (error) {
      if (isWorkspaceCurrent(workspaceId)) {
        setActionError(error instanceof Error ? error.message : "Failed to revoke share link.")
      }
    }
  }

  const loadMoreReports = async () => {
    if (!nextCursor || loadingMoreReports) return
    const requestId = ++reportsPageRequestRef.current
    const listRequestId = reportsRequestRef.current
    const cursor = nextCursor
    setLoadingMoreReports(true)
    setReportsPageError(null)
    try {
      const res = await apiGetPaginated<ReportItem>(
        "/api/reports",
        { workspaceId, cursor },
        { schema: reportsPaginatedSchema }
      )
      if (
        !isWorkspaceCurrent(workspaceId) ||
        reportsPageRequestRef.current !== requestId ||
        reportsRequestRef.current !== listRequestId
      ) {
        return
      }
      setReports((current) => {
        const knownIds = new Set(current.map((report) => report.id))
        return [...current, ...res.items.filter((report) => !knownIds.has(report.id))]
      })
      setNextCursor(res.nextCursor)
    } catch (error) {
      if (
        isWorkspaceCurrent(workspaceId) &&
        reportsPageRequestRef.current === requestId &&
        reportsRequestRef.current === listRequestId
      ) {
        const failure = readFailure(error, "Failed to load more reports.")
        setReportsPageError(failure.message)
      }
    } finally {
      if (isWorkspaceCurrent(workspaceId) && reportsPageRequestRef.current === requestId) {
        setLoadingMoreReports(false)
      }
    }
  }

  const copyToClipboard = async () => {
    const requestWorkspaceId = workspaceId
    if (!shareUrl) return
    try {
      await writeClipboard(shareUrl)
      if (isWorkspaceCurrent(requestWorkspaceId)) setCopied("link")
    } catch {
      if (isWorkspaceCurrent(requestWorkspaceId)) setActionError("Failed to copy share link.")
    }
  }

  const handoffMessage = shareUrl
    ? `Security scan ready for your review. This private link expires in 30 days: ${shareUrl}`
    : ""
  const showShareUrl = shareUrl && sharedReportId ? shareUrl : null

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button
          className="self-start sm:self-auto"
          onClick={() => setShowCreateForm((shown) => !shown)}
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
          scanCursor={scanCursor}
          loadingScans={loadingScans}
          loadingMoreScans={loadingMoreScans}
          scansError={scansError}
          scanPageError={scanPageError}
          linkedScanUnavailable={linkedScanUnavailable}
          scopeValue={scopeValue(creationScope)}
          onScopeChange={onScopeChange}
          onRetryScans={() => void loadScans()}
          onLoadMoreScans={() => void loadMoreScans()}
          creating={creatingReport}
          canCreate={canCreate}
          onCreate={() => void handleCreateReport()}
          onCancel={resetCreateForm}
          onUseWorkspaceScope={() => {
            updateCreationScope({ kind: "workspace" })
            setActionError(null)
          }}
        />
      )}

      {actionError && <DashboardErrorCard message={actionError} />}

      {showShareUrl && (
        <ShareLinkCard
          shareUrl={showShareUrl}
          copied={copied}
          handoffMessage={handoffMessage}
          onCopyLink={() => void copyToClipboard()}
          onCopyHandoff={() => {
            const requestWorkspaceId = workspaceId
            void writeClipboard(handoffMessage)
              .then(() => {
                if (isWorkspaceCurrent(requestWorkspaceId)) setCopied("handoff")
              })
              .catch(() => {
                if (isWorkspaceCurrent(requestWorkspaceId)) {
                  setActionError("Failed to copy client handoff.")
                }
              })
          }}
        />
      )}

      <section aria-labelledby="workspace-report-history-title">
        <div className="mb-3">
          <h2 id="workspace-report-history-title" className="font-semibold">
            Workspace report history
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Shows every report in this workspace, whether it covers one scan or all workspace
            findings.
          </p>
        </div>

        {reportsError?.kind === "denied" ? (
          <div className="border-destructive/50 rounded-lg border p-4" role="alert">
            <h3 className="font-medium">Report history unavailable</h3>
            <p className="text-muted-foreground mt-1 text-sm">{reportsError.message}</p>
          </div>
        ) : reportsError ? (
          <DashboardErrorCard message={reportsError.message} onRetry={() => void loadReports()} />
        ) : loadingReports ? (
          <div
            className="space-y-3"
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label="Loading workspace report history"
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

            {reportsPageError && (
              <p className="text-destructive text-sm" role="alert">
                {reportsPageError}
              </p>
            )}
            {nextCursor && (
              <div className="flex justify-center pt-4">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={loadingMoreReports}
                  aria-busy={loadingMoreReports}
                  onClick={() => void loadMoreReports()}
                >
                  {loadingMoreReports ? <Spinner className="mr-2 h-4 w-4" /> : null}
                  {loadingMoreReports ? "Loading…" : "Load more reports"}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
