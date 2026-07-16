"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Radar, Play, X, RefreshCw, ChevronRight } from "lucide-react"
import { Button, Card, Badge, FormField, Select, EmptyState, Spinner } from "@lyrashield/ui"
import { apiPost, apiGetPaginated } from "@/lib/api-client"
import { formatDateTime } from "@/lib/date-format"
import { mergePolledScans } from "./scans-client.utils"

interface ScanItem {
  id: string
  status: string
  goal: string
  mode: string
  triggerType: string
  startedAt: string | null
  endedAt: string | null
  summary: string | null
  errorCategory: string | null
  errorMessage: string | null
  findingCount?: number
  target: {
    id: string
    name: string
    type: string
    url: string | null
    repoFullName: string | null
  } | null
  createdAt: string
}

interface TargetItem {
  id: string
  name: string
  type: string
  url: string | null
  repoFullName: string | null
}

interface ScansClientProps {
  workspaceId: string
  targets: TargetItem[]
  initialData: ScanItem[]
  initialNextCursor: string | null
}

const STATUS_VARIANT: Record<
  string,
  "default" | "success" | "danger" | "warning" | "info" | "muted"
> = {
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

const GOAL_LABELS: Record<string, string> = {
  CHECK_PR: "Check PR",
  TEST_APP: "Test App",
  LAUNCH_REVIEW: "Launch Review",
  WEEKLY_MONITOR: "Weekly Monitor",
  FULL_PENTEST: "Full Pentest",
  COMPLIANCE_REVIEW: "Compliance Review",
}

export function ScansClient({
  workspaceId,
  targets,
  initialData,
  initialNextCursor,
}: ScansClientProps) {
  const [scans, setScans] = useState<ScanItem[]>(initialData)
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasLoadedMore, setHasLoadedMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedTarget, setSelectedTarget] = useState("")
  const [selectedGoal, setSelectedGoal] = useState("TEST_APP")
  const [selectedMode, setSelectedMode] = useState("SAFE")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)

  async function handleCreateScan() {
    if (!selectedTarget) {
      setError("Select a target to scan")
      return
    }
    setCreating(true)
    setError(null)
    try {
      const result = await apiPost<ScanItem>("/api/scans", {
        workspaceId,
        targetId: selectedTarget,
        goal: selectedGoal,
        mode: selectedMode,
      })
      setScans((prev) => [result, ...prev])
      setShowCreate(false)
      setSelectedTarget("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create scan")
    } finally {
      setCreating(false)
    }
  }

  async function handleCancelScan(scanId: string) {
    if (!window.confirm("Cancel this scan? Any active scanner work will be stopped.")) return
    setCancelling(scanId)
    setError(null)
    try {
      const result = await apiPost<{ id: string; status: string; endedAt: string | null }>(
        `/api/scans/${scanId}`,
        {}
      )
      setScans((prev) =>
        prev.map((s) =>
          s.id === scanId ? { ...s, status: result.status, endedAt: result.endedAt } : s
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel scan")
    } finally {
      setCancelling(null)
    }
  }

  async function handleLoadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const result = await apiGetPaginated<ScanItem>("/api/scans", {
        workspaceId,
        cursor: nextCursor,
      })
      setScans((prev) => [...prev, ...result.items])
      setNextCursor(result.nextCursor)
      setHasLoadedMore(true)
    } catch {
      setError("Failed to load more scans")
    } finally {
      setLoadingMore(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    setError(null)
    try {
      const result = await apiGetPaginated<ScanItem>("/api/scans", { workspaceId })
      setScans(result.items)
      setNextCursor(result.nextCursor)
      setHasLoadedMore(false)
    } catch {
      setError("Failed to refresh scans")
    } finally {
      setRefreshing(false)
    }
  }

  const isActive = (status: string) =>
    ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"].includes(status)
  const hasActiveScans = scans.some((scan) => isActive(scan.status))

  useEffect(() => {
    if (!hasActiveScans) return
    const interval = window.setInterval(() => {
      void apiGetPaginated<ScanItem>("/api/scans", { workspaceId })
        .then((result) => {
          setScans((current) =>
            hasLoadedMore ? mergePolledScans(current, result.items) : result.items
          )
          if (!hasLoadedMore) setNextCursor(result.nextCursor)
        })
        .catch(() => {
          // Keep the current list visible; the manual refresh action reports errors.
        })
    }, 10_000)
    return () => window.clearInterval(interval)
  }, [hasActiveScans, hasLoadedMore, workspaceId])

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Scans</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Run and monitor security scans against your targets
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw
              className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Refresh
          </Button>
          {targets.length > 0 && (
            <Button onClick={() => setShowCreate(!showCreate)}>
              <Play className="mr-2 h-4 w-4" aria-hidden="true" />
              New Scan
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="border-destructive/50 bg-destructive/10 text-destructive mb-4 rounded-lg border p-3 text-sm"
        >
          {error}
        </div>
      )}

      {showCreate && (
        <Card className="mb-6 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Start New Scan</h2>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Close"
              onClick={() => setShowCreate(false)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Target" htmlFor="scan-target">
              <Select
                id="scan-target"
                value={selectedTarget}
                onChange={(e) => setSelectedTarget(e.target.value)}
              >
                <option value="">Select a target…</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.type})
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Goal" htmlFor="scan-goal">
              <Select
                id="scan-goal"
                value={selectedGoal}
                onChange={(e) => setSelectedGoal(e.target.value)}
              >
                <option value="CHECK_PR">Check PR</option>
                <option value="TEST_APP">Test App</option>
                <option value="LAUNCH_REVIEW">Launch Review</option>
                <option value="WEEKLY_MONITOR">Weekly Monitor</option>
                <option value="FULL_PENTEST">Full Pentest</option>
                <option value="COMPLIANCE_REVIEW">Compliance Review</option>
              </Select>
            </FormField>
            <FormField label="Mode" htmlFor="scan-mode">
              <Select
                id="scan-mode"
                value={selectedMode}
                onChange={(e) => setSelectedMode(e.target.value)}
              >
                <option value="SAFE">Safe</option>
                <option value="QUICK">Quick</option>
                <option value="STANDARD">Standard</option>
                <option value="DEEP">Deep</option>
              </Select>
            </FormField>
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={handleCreateScan} disabled={creating || !selectedTarget}>
              {creating ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" />
                  Starting…
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                  Start Scan
                </>
              )}
            </Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {scans.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No scans yet"
          description={
            targets.length > 0
              ? 'Start your first security scan by clicking "New Scan" above.'
              : "Add a target first (a repo or URL), then you can run scans against it."
          }
        />
      ) : (
        <div className="space-y-3">
          {scans.map((scan) => (
            <Card
              key={scan.id}
              className="hover:shadow-card-hover p-4 transition-shadow duration-200"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge variant={STATUS_VARIANT[scan.status] ?? "muted"}>{scan.status}</Badge>
                    <span className="text-sm font-medium">
                      {GOAL_LABELS[scan.goal] ?? scan.goal}
                    </span>
                    <span className="text-muted-foreground text-xs">{scan.mode}</span>
                  </div>
                  {scan.target && (
                    <p className="mb-1 truncate text-sm">
                      <span className="font-medium">{scan.target.name}</span>
                      <span className="text-muted-foreground ml-2">
                        {scan.target.repoFullName ?? scan.target.url ?? scan.target.type}
                      </span>
                    </p>
                  )}
                  {scan.summary && <p className="text-muted-foreground text-sm">{scan.summary}</p>}
                  {scan.errorMessage && (
                    <p className="text-destructive text-sm">{scan.errorMessage}</p>
                  )}
                  <div className="text-muted-foreground mt-1 flex items-center gap-3 text-xs">
                    <span>{formatDateTime(scan.createdAt)}</span>
                    {scan.endedAt && <span>· ended {formatDateTime(scan.endedAt)}</span>}
                    {scan.findingCount !== undefined && scan.findingCount > 0 && (
                      <span className="text-foreground font-medium">
                        {scan.findingCount} finding{scan.findingCount !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isActive(scan.status) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCancelScan(scan.id)}
                      disabled={cancelling === scan.id}
                    >
                      {cancelling === scan.id ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <X className="h-4 w-4" aria-hidden="true" />
                      )}
                      <span className="ml-1">Cancel</span>
                    </Button>
                  )}
                  <Link
                    href={`/dashboard/scans/${scan.id}`}
                    aria-label={`View details for ${scan.target?.name ?? "scan"}`}
                    className="text-muted-foreground hover:text-foreground inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg"
                  >
                    <ChevronRight className="h-5 w-5" aria-hidden="true" />
                  </Link>
                </div>
              </div>
            </Card>
          ))}

          {nextCursor && (
            <div className="flex justify-center pt-4">
              <Button variant="outline" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? <Spinner /> : "Load More"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
