"use client"

import { useState } from "react"
import Link from "next/link"
import { Radar, Play, X, RefreshCw, ChevronRight } from "lucide-react"
import { Button, Card, Badge, FormField, Select, EmptyState, Spinner } from "@lyrashield/ui"
import { apiPost, apiGetPaginated } from "@/lib/api-client"

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
    setCancelling(scanId)
    setError(null)
    try {
      const result = await apiPost<{ id: string; status: string; endedAt: string | null }>(
        `/api/scans/${scanId}`,
        {}
      )
      setScans((prev) =>
        prev.map((s) => (s.id === scanId ? { ...s, status: result.status, endedAt: result.endedAt } : s))
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
    } catch {
      setError("Failed to refresh scans")
    } finally {
      setRefreshing(false)
    }
  }

  const isActive = (status: string) =>
    ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"].includes(status)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Scans</h1>
          <p className="mt-1 text-sm text-muted-foreground">Run and monitor security scans against your targets</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
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
          className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {showCreate && (
        <Card className="mb-6 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Start New Scan</h2>
            <Button variant="ghost" size="sm" aria-label="Close" onClick={() => setShowCreate(false)}>
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Target" htmlFor="scan-target">
              <Select id="scan-target" value={selectedTarget} onChange={(e) => setSelectedTarget(e.target.value)}>
                <option value="">Select a target…</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.type})
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Goal" htmlFor="scan-goal">
              <Select id="scan-goal" value={selectedGoal} onChange={(e) => setSelectedGoal(e.target.value)}>
                <option value="CHECK_PR">Check PR</option>
                <option value="TEST_APP">Test App</option>
                <option value="LAUNCH_REVIEW">Launch Review</option>
                <option value="WEEKLY_MONITOR">Weekly Monitor</option>
                <option value="FULL_PENTEST">Full Pentest</option>
                <option value="COMPLIANCE_REVIEW">Compliance Review</option>
              </Select>
            </FormField>
            <FormField label="Mode" htmlFor="scan-mode">
              <Select id="scan-mode" value={selectedMode} onChange={(e) => setSelectedMode(e.target.value)}>
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
              ? "Start your first security scan by clicking \"New Scan\" above."
              : "Add a target first (a repo or URL), then you can run scans against it."
          }
        />
      ) : (
        <div className="space-y-3">
          {scans.map((scan) => (
            <Card key={scan.id} className="p-4 transition-shadow duration-200 hover:shadow-card-hover">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge variant={STATUS_VARIANT[scan.status] ?? "muted"}>{scan.status}</Badge>
                    <span className="text-sm font-medium">{GOAL_LABELS[scan.goal] ?? scan.goal}</span>
                    <span className="text-xs text-muted-foreground">{scan.mode}</span>
                  </div>
                  {scan.target && (
                    <p className="mb-1 truncate text-sm">
                      <span className="font-medium">{scan.target.name}</span>
                      <span className="ml-2 text-muted-foreground">
                        {scan.target.repoFullName ?? scan.target.url ?? scan.target.type}
                      </span>
                    </p>
                  )}
                  {scan.summary && (
                    <p className="text-sm text-muted-foreground">{scan.summary}</p>
                  )}
                  {scan.errorMessage && (
                    <p className="text-sm text-destructive">{scan.errorMessage}</p>
                  )}
                  <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{new Date(scan.createdAt).toLocaleString()}</span>
                    {scan.endedAt && <span>· ended {new Date(scan.endedAt).toLocaleString()}</span>}
                    {scan.findingCount !== undefined && scan.findingCount > 0 && (
                      <span className="font-medium text-foreground">{scan.findingCount} finding{scan.findingCount !== 1 ? "s" : ""}</span>
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
                  <Link href={`/dashboard/scans/${scan.id}`} className="text-muted-foreground hover:text-foreground">
                    <ChevronRight className="h-5 w-5" aria-label="View scan details" />
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
