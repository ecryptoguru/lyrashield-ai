"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Radar, Play, X, RefreshCw, ChevronRight, ChevronDown, Check } from "lucide-react"
import {
  Button,
  buttonVariants,
  Card,
  Badge,
  FormField,
  Select,
  EmptyState,
  Spinner,
  cn,
} from "@lyrashield/ui"
import { Skeleton } from "@/components/ui/skeleton"
import { z } from "zod"
import { paginatedResponseSchema } from "@/lib/api-schemas"
import { apiPost, apiGetPaginated, apiGetPaginatedConditional } from "@/lib/api-client"
import { formatDateTime } from "@/lib/date-format"
import { RUN_PLURAL, RUN_SINGULAR, TARGET_PLURAL, TARGET_SINGULAR } from "@/lib/terminology"
import { mergePolledScans } from "./scans-client.utils"
import { getScanPresentation, isActiveScan } from "@/lib/scan-presentation"
import {
  getScanPreset,
  SCAN_PRESETS,
  SCAN_PRESET_ORDER,
  type ScanPresetId,
} from "@/lib/scan-presets"
import { InlineConfirm } from "@/components/ui/inline-confirm"
import { getGoalLabel } from "@/lib/labels"

function modeBadgeVariant(mode: string): "default" | "success" | "info" | "warning" | "muted" {
  switch (mode) {
    case "SAFE":
      return "success"
    case "STANDARD":
      return "info"
    case "DEEP":
      return "warning"
    default:
      return "default"
  }
}

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

const scanTargetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    url: z.string().nullable(),
    repoFullName: z.string().nullable(),
  })
  .passthrough()

const scanCancelSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    endedAt: z.string().datetime().or(z.string()).nullable(),
  })
  .passthrough()

const scanItemSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    goal: z.string(),
    mode: z.string(),
    triggerType: z.string(),
    startedAt: z.string().datetime().or(z.string()).nullable(),
    endedAt: z.string().datetime().or(z.string()).nullable(),
    summary: z.string().nullable(),
    errorCategory: z.string().nullable(),
    errorMessage: z.string().nullable(),
    findingCount: z.number().optional(),
    target: scanTargetSchema.nullable(),
    createdAt: z.string().datetime().or(z.string()),
  })
  .passthrough()

const scansPaginatedSchema = paginatedResponseSchema(scanItemSchema)

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
      const result = await apiPost(
        "/api/scans",
        {
          workspaceId,
          targetId: selectedTarget,
          goal: preset.goal,
          mode: preset.mode,
        },
        { schema: scanItemSchema }
      )
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
      const result = await apiPost(
        `/api/scans/${scanId}`,
        { workspaceId },
        { schema: scanCancelSchema }
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
      const result = await apiGetPaginated<ScanItem>(
        "/api/scans",
        {
          workspaceId,
          cursor: nextCursor,
        },
        { schema: scansPaginatedSchema }
      )
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
      const result = await apiGetPaginated<ScanItem>(
        "/api/scans",
        { workspaceId },
        { schema: scansPaginatedSchema }
      )
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

    const HIDDEN_POLL_INTERVAL_MS = 1_000
    const INITIAL_POLL_DELAY_MS = 10_000
    const VISIBILITY_POLL_DELAY_MS = 0
    const POLL_FAST_INTERVAL_MS = 10_000
    const POLL_MEDIUM_INTERVAL_MS = 30_000
    const POLL_SLOW_INTERVAL_MS = 60_000
    const POLL_MEDIUM_THRESHOLD_MS = 5 * 60_000
    const POLL_SLOW_THRESHOLD_MS = 60_000

    const nextInterval = (elapsedMs: number): number => {
      if (elapsedMs < POLL_SLOW_THRESHOLD_MS) return POLL_FAST_INTERVAL_MS
      if (elapsedMs < POLL_MEDIUM_THRESHOLD_MS) return POLL_MEDIUM_INTERVAL_MS
      return POLL_SLOW_INTERVAL_MS
    }

    const poll = async () => {
      if (document.hidden) {
        timeoutId = window.setTimeout(poll, HIDDEN_POLL_INTERVAL_MS)
        return
      }
      try {
        // Poll only active-status scans to keep the payload small. Merge the
        // refreshed active rows into the full list so completed scans are preserved.
        // The ETag from the previous tick makes an unchanged list a bodyless 304.
        const { data, etag } = await apiGetPaginatedConditional(
          "/api/scans",
          { workspaceId, status: ACTIVE_STATUS_PARAM },
          {
            signal: controller.signal,
            schema: scansPaginatedSchema,
            ...(pollEtag ? { etag: pollEtag } : {}),
          }
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
      const nextPollDelay = nextInterval(elapsed)
      timeoutId = window.setTimeout(poll, nextPollDelay)
    }

    timeoutId = window.setTimeout(poll, INITIAL_POLL_DELAY_MS)

    const onVisibility = () => {
      if (!document.hidden && hasActiveScans && !isAborted) {
        window.clearTimeout(timeoutId)
        timeoutId = window.setTimeout(poll, VISIBILITY_POLL_DELAY_MS)
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
          <h1 className="text-2xl font-bold tracking-tight">{RUN_PLURAL}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Run and monitor {RUN_PLURAL.toLowerCase()} against your {TARGET_PLURAL.toLowerCase()}
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
              New {RUN_SINGULAR}
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
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">
                Start a {RUN_SINGULAR.toLowerCase()}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Choose a {TARGET_SINGULAR.toLowerCase()} and how thorough the review should be.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Close"
              onClick={() => setShowCreate(false)}
              className="min-h-11 min-w-11 shrink-0"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          <div className="space-y-5">
            <FormField label={TARGET_SINGULAR} htmlFor="scan-target">
              <Select
                id="scan-target"
                value={selectedTarget}
                onChange={(e) => setSelectedTarget(e.target.value)}
              >
                <option value="">Select a {TARGET_SINGULAR.toLowerCase()}…</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.type})
                  </option>
                ))}
              </Select>
            </FormField>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="block text-sm font-medium">Review type</p>
                <span className="text-muted-foreground text-[11px]">Simple options — pick one</span>
              </div>

              <div
                role="radiogroup"
                aria-label="Review type"
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
              >
                {SCAN_PRESET_ORDER.map((presetId) => {
                  const preset = SCAN_PRESETS[presetId]
                  const isSelected = selectedPreset === presetId
                  return (
                    <button
                      key={presetId}
                      id={`preset-${presetId}`}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      aria-label={`${preset.label}: ${preset.description}`}
                      tabIndex={isSelected ? 0 : -1}
                      onClick={() => setSelectedPreset(presetId)}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                          e.preventDefault()
                          const idx = SCAN_PRESET_ORDER.indexOf(presetId)
                          const next = SCAN_PRESET_ORDER[(idx + 1) % SCAN_PRESET_ORDER.length]!
                          setSelectedPreset(next)
                          document.getElementById(`preset-${next}`)?.focus()
                        }
                        if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                          e.preventDefault()
                          const idx = SCAN_PRESET_ORDER.indexOf(presetId)
                          const prev =
                            SCAN_PRESET_ORDER[
                              (idx - 1 + SCAN_PRESET_ORDER.length) % SCAN_PRESET_ORDER.length
                            ]!
                          setSelectedPreset(prev)
                          document.getElementById(`preset-${prev}`)?.focus()
                        }
                      }}
                      className={cn(
                        "group focus-visible:ring-ring relative flex min-h-23 w-full flex-col items-start rounded-lg border p-4 text-left shadow-xs transition-[border-color,box-shadow,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                        isSelected
                          ? "border-primary bg-primary/6 dark:bg-primary/12 ring-primary/20 shadow-sm ring-1"
                          : "border-border bg-card hover:border-border/80 hover:bg-accent/50"
                      )}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-sm font-semibold tracking-tight">{preset.label}</span>
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant={modeBadgeVariant(preset.mode)}
                            className="px-2 py-0 text-[10px] font-semibold tracking-wide uppercase"
                          >
                            {preset.mode}
                          </Badge>
                          {isSelected ? (
                            <span className="bg-primary text-primary-foreground inline-flex size-5 items-center justify-center rounded-full">
                              <Check className="size-3" aria-hidden="true" />
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span className="text-muted-foreground mt-1.5 line-clamp-3 text-xs leading-relaxed">
                        {preset.description}
                      </span>
                    </button>
                  )
                })}
              </div>

              <p className="text-muted-foreground mt-2 text-xs">
                {getScanPreset(selectedPreset).hint}{" "}
                {selectedTarget && !selectedTargetUsesEngine
                  ? "This target uses deterministic scanners."
                  : "A protected limit is applied automatically."}
              </p>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                aria-expanded={showAdvanced}
                aria-controls="scan-advanced-panel"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none"
              >
                <ChevronDown
                  className={cn(
                    "size-4 transition-transform duration-(--duration-fast) ease-out",
                    showAdvanced ? "rotate-180" : ""
                  )}
                  aria-hidden="true"
                />
                Details
              </button>

              {showAdvanced && (
                <div
                  id="scan-advanced-panel"
                  className="bg-muted/40 border-border mt-2 rounded-lg border p-4"
                >
                  {(() => {
                    const preset = getScanPreset(selectedPreset)
                    return (
                      <div className="space-y-3">
                        <div>
                          <p className="text-sm font-medium">{preset.label}</p>
                          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                            {preset.hint}
                          </p>
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="bg-card border-border rounded-md border px-3 py-2.5">
                            <p className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">
                              Goal
                            </p>
                            <p className="mt-1 text-xs font-medium">
                              {getGoalLabel(preset.goal)}
                              <span className="text-muted-foreground ml-1.5 font-normal">
                                · {preset.goal}
                              </span>
                            </p>
                          </div>
                          <div className="bg-card border-border rounded-md border px-3 py-2.5">
                            <p className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">
                              Mode
                            </p>
                            <div className="mt-1.5 flex items-center gap-2">
                              <Badge
                                variant={modeBadgeVariant(preset.mode)}
                                className="text-[11px] font-semibold tracking-wide uppercase"
                              >
                                {preset.mode}
                              </Badge>
                              <span className="text-muted-foreground text-xs">
                                {preset.mode === "SAFE"
                                  ? "Bounded, fast"
                                  : preset.mode === "STANDARD"
                                    ? "Repo + deps"
                                    : "Cross-file deep"}
                              </span>
                            </div>
                          </div>
                        </div>
                        <p className="text-muted-foreground text-[11px] leading-relaxed">
                          No extra fields — we send{" "}
                          <code className="bg-card border-border rounded border px-1 py-0.5 text-[11px]">
                            goal
                          </code>{" "}
                          and{" "}
                          <code className="bg-card border-border rounded border px-1 py-0.5 text-[11px]">
                            mode
                          </code>{" "}
                          from this preset.{" "}
                          {selectedTarget && !selectedTargetUsesEngine
                            ? "This URL target uses deterministic scanners."
                            : "Engine targets get a protected run budget automatically."}
                        </p>
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 flex gap-2">
            <Button
              onClick={handleCreateScan}
              disabled={creating || !selectedTarget}
              className="min-h-11"
            >
              {creating ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" />
                  Starting…
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                  Start {RUN_SINGULAR}
                </>
              )}
            </Button>
            <Button variant="outline" onClick={() => setShowCreate(false)} className="min-h-11">
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {refreshing && scans.length === 0 ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label={`Loading ${RUN_PLURAL.toLowerCase()}`}
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-32 w-full" />
          ))}
        </div>
      ) : scans.length === 0 ? (
        <EmptyState
          icon={Radar}
          title={`No ${RUN_PLURAL.toLowerCase()} yet`}
          description={
            targets.length > 0
              ? `Start your first ${RUN_SINGULAR.toLowerCase()} by clicking "New ${RUN_SINGULAR}" above.`
              : `Add a ${TARGET_SINGULAR.toLowerCase()} first, then you can run ${RUN_PLURAL.toLowerCase()} against it.`
          }
          action={
            targets.length > 0 ? (
              <Button onClick={() => setShowCreate(true)}>
                <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                New {RUN_SINGULAR}
              </Button>
            ) : (
              <Link href="/dashboard/targets" className={buttonVariants()}>
                Add a {TARGET_SINGULAR.toLowerCase()}
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
                      <p className="text-destructive text-sm">{scan.errorMessage}</p>
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
