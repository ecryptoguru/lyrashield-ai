"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Radar, Play, X, RefreshCw, ChevronRight, ChevronDown } from "lucide-react"
import {
  Button,
  buttonVariants,
  Card,
  Badge,
  FormField,
  Select,
  EmptyState,
  Spinner,
} from "@lyrashield/ui"
import { Skeleton } from "@/components/ui/skeleton"
import { apiPost, apiGetPaginated, apiGetPaginatedConditional } from "@/lib/api-client"
import { formatDateTime } from "@/lib/date-format"
import { mergePolledScans } from "./scans-client.utils"
import { getScanPresentation, isActiveScan } from "@/lib/scan-presentation"
import { getScanPreset, SCAN_PRESETS, type ScanPresetId } from "@/lib/scan-presets"
import { InlineConfirm } from "@/components/ui/inline-confirm"
import { getGoalLabel } from "@/lib/labels"

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
  initialShowCreate?: boolean
}

export function ScansClient({
  workspaceId,
  targets,
  initialData,
  initialNextCursor,
  initialShowCreate = false,
}: ScansClientProps) {
  const [scans, setScans] = useState<ScanItem[]>(initialData)
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showCreate, setShowCreate] = useState(initialShowCreate)
  const [selectedTarget, setSelectedTarget] = useState("")
  const [selectedPreset, setSelectedPreset] = useState<ScanPresetId>("RELEASE_CHECK")
  const [showAdvanced, setShowAdvanced] = useState(false)
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
      const preset = getScanPreset(selectedPreset)
      const result = await apiPost<ScanItem>("/api/scans", {
        workspaceId,
        targetId: selectedTarget,
        goal: preset.goal,
        mode: preset.mode,
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
        { workspaceId }
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

  const hasActiveScans = scans.some((scan) => isActiveScan(scan.status))
  const selectedTargetUsesEngine =
    targets.find((target) => target.id === selectedTarget)?.type === "REPO"

  const ACTIVE_STATUS_PARAM = "QUEUED,PREFLIGHT,RUNNING,VERIFYING,REQUIRES_APPROVAL"

  useEffect(() => {
    if (!hasActiveScans) return
    const controller = new AbortController()
    let timeoutId: number | undefined
    let isAborted = false
    let pollEtag: string | undefined
    const pollStartedAt = Date.now()

    const nextInterval = (elapsedMs: number): number => {
      if (elapsedMs < 60_000) return 10_000
      if (elapsedMs < 5 * 60_000) return 30_000
      return 60_000
    }

    const poll = async () => {
      if (document.hidden) {
        timeoutId = window.setTimeout(poll, 1000)
        return
      }
      try {
        // Poll only active-status scans to keep the payload small. Merge the
        // refreshed active rows into the full list so completed scans are preserved.
        // The ETag from the previous tick makes an unchanged list a bodyless 304.
        const { data, etag } = await apiGetPaginatedConditional<ScanItem>(
          "/api/scans",
          { workspaceId, status: ACTIVE_STATUS_PARAM },
          { signal: controller.signal, ...(pollEtag ? { etag: pollEtag } : {}) }
        )
        if (etag) pollEtag = etag
        if (data && !controller.signal.aborted) {
          setScans((current) => mergePolledScans(current, data.items))
        }
      } catch {
        // Keep the current list visible; the manual refresh action reports errors.
      }
      if (isAborted) return
      const elapsed = Date.now() - pollStartedAt
      timeoutId = window.setTimeout(poll, nextInterval(elapsed))
    }

    timeoutId = window.setTimeout(poll, 10_000)

    const onVisibility = () => {
      if (!document.hidden && hasActiveScans && !isAborted) {
        window.clearTimeout(timeoutId)
        timeoutId = window.setTimeout(poll, 0)
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      isAborted = true
      controller.abort()
      document.removeEventListener("visibilitychange", onVisibility)
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    }
  }, [hasActiveScans, workspaceId])

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trust Runs</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Run and monitor trust runs against your products
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
            <h2 className="text-lg font-semibold">Start a trust run</h2>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Close"
              onClick={() => setShowCreate(false)}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
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
          </div>
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium"
            >
              <ChevronDown
                className={`size-4 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out)] ${showAdvanced ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
              Advanced
            </button>
            {showAdvanced && (
              <div className="mt-3">
                <FormField label="Review depth" htmlFor="scan-preset">
                  <Select
                    id="scan-preset"
                    value={selectedPreset}
                    onChange={(e) => setSelectedPreset(e.target.value as ScanPresetId)}
                  >
                    {(["RELEASE_CHECK", "CODE_REVIEW", "DEEP_REVIEW"] as const).map((id) => (
                      <option key={id} value={id}>
                        {SCAN_PRESETS[id].label}
                      </option>
                    ))}
                  </Select>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {getScanPreset(selectedPreset).description}{" "}
                    {selectedTarget && !selectedTargetUsesEngine
                      ? "This target uses deterministic scanners."
                      : "A protected run limit is applied automatically."}
                  </p>
                </FormField>
              </div>
            )}
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
                  Start Trust Run
                </>
              )}
            </Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {refreshing && scans.length === 0 ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading trust runs">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-32 w-full" />
          ))}
        </div>
      ) : scans.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No trust runs yet"
          description={
            targets.length > 0
              ? 'Start your first trust run by clicking "New Trust Run" above.'
              : "Add a product first, then you can run trust reviews against it."
          }
          action={
            targets.length > 0 ? (
              <Button onClick={() => setShowCreate(true)}>
                <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                New Trust Run
              </Button>
            ) : (
              <Link href="/dashboard/products" className={buttonVariants()}>
                Add a product
              </Link>
            )
          }
        />
      ) : (
        <div className="space-y-3">
          {scans.map((scan) => {
            const presentation = getScanPresentation(scan.status)
            return (
              <Card key={scan.id} className="p-4">
                <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge variant={presentation.badgeVariant}>{presentation.label}</Badge>
                      <span className="text-sm font-medium">{getGoalLabel(scan.goal)}</span>
                    </div>
                    {scan.target && (
                      <p className="mb-1 truncate text-sm">
                        <span className="font-medium">{scan.target.name}</span>
                        <span className="text-muted-foreground ml-2">
                          {scan.target.repoFullName ?? scan.target.url ?? scan.target.type}
                        </span>
                      </p>
                    )}
                    {scan.summary && presentation.assuranceAvailable && (
                      <p className="text-muted-foreground text-sm">{scan.summary}</p>
                    )}
                    {scan.errorMessage && (
                      <p className="text-destructive text-sm">{presentation.description}</p>
                    )}
                    <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span className="whitespace-nowrap">{formatDateTime(scan.createdAt)}</span>
                      {scan.endedAt && (
                        <span className="whitespace-nowrap">
                          · ended {formatDateTime(scan.endedAt)}
                        </span>
                      )}
                      {scan.findingCount !== undefined && scan.findingCount > 0 && (
                        <span className="text-foreground font-medium whitespace-nowrap">
                          {scan.findingCount} finding{scan.findingCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isActiveScan(scan.status) &&
                      (cancelling === scan.id ? (
                        <Button variant="outline" size="sm" disabled>
                          <Spinner className="h-4 w-4" />
                          <span className="ml-1">Cancelling…</span>
                        </Button>
                      ) : (
                        <InlineConfirm
                          triggerLabel="Cancel"
                          triggerIcon={<X className="mr-1 h-4 w-4" aria-hidden="true" />}
                          triggerVariant="outline"
                          confirmLabel="Stop scan"
                          message="Stop this scan?"
                          aria-label="Cancel this scan"
                          onConfirm={() => handleCancelScan(scan.id)}
                        />
                      ))}
                    <Link
                      href={`/dashboard/scans/${scan.id}`}
                      aria-label={`View details for ${scan.target?.name ?? "scan"}`}
                      className="text-muted-foreground hover:text-foreground inline-flex min-h-11 min-w-11 items-center justify-center"
                    >
                      <ChevronRight className="h-5 w-5" aria-hidden="true" />
                    </Link>
                  </div>
                </div>
              </Card>
            )
          })}

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
