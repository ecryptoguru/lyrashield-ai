"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useScansWebMcp } from "./scans-webmcp"
import Link from "next/link"
import {
  Radar,
  Play,
  X,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Check,
  Clock,
  Trash2,
  RotateCcw,
  AlertCircle,
} from "lucide-react"
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { z } from "zod"
import { paginatedResponseSchema } from "@/lib/api-schemas"
import {
  ApiError,
  apiDelete,
  apiPost,
  apiGet,
  apiGetPaginated,
  apiGetPaginatedConditional,
} from "@/lib/api-client"
import { formatDateTime } from "@/lib/date-format"
import { RUN_PLURAL, RUN_SINGULAR, TARGET_PLURAL, TARGET_SINGULAR } from "@/lib/terminology"
import {
  findRecoveryPreset,
  getReviewSetupGuidance,
  isBillingRecoveryCode,
  mergePolledScans,
  mergeResolvedOffPageScans,
  missingActiveScanIds,
  scanRecoveryHref,
} from "./scans-client.utils"
import {
  getScanPresentation,
  isActiveScan,
  SCAN_STATE_FILTERS,
  parseScanStateFilter,
  scanStateStatusLabel,
  type ScanStateFilter,
} from "@/lib/scan-presentation"
import { getManualScanOptions } from "@/lib/scan-presets"
import { InlineConfirm } from "@/components/ui/inline-confirm"
import { getGoalLabel, modeLabel } from "@/lib/labels"
import { formatEstimate } from "@/lib/estimator"
import { safeApiErrorMessage } from "@/components/api-error-card"

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

export interface TargetItem {
  id: string
  name: string
  type: string
  url: string | null
  apiSpecUrl: string | null
  repoFullName: string | null
}

const scanTargetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    url: z.string().nullable(),
    apiSpecUrl: z.string().nullable(),
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

const eligibilitySchema = z.object({
  allowed: z.boolean(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  plan: z.string(),
  isTrial: z.boolean(),
  remainingMinutes: z.number(),
})

type Eligibility = z.infer<typeof eligibilitySchema>

type EligibilityState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; eligibility: Eligibility }
  | { status: "error" }

/**
 * Media query with SSR-safe hydration: the server snapshot (mobile) is used
 * for the first render, then the client value applies — the same pattern the
 * reduced-motion hook uses, so server and hydrated HTML always match.
 */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (callback) => {
      const mql = window.matchMedia(query)
      mql.addEventListener("change", callback)
      return () => mql.removeEventListener("change", callback)
    },
    () => window.matchMedia(query).matches,
    () => false
  )
}

interface ScansClientProps {
  workspaceId: string
  targets: TargetItem[]
  initialData: ScanItem[]
  initialNextCursor: string | null
  initialShowCreate?: boolean
  initialTargetId?: string
  initialGoal?: string
  initialMode?: string
  /** Server-parsed URL filter state — never re-read from window here. */
  initialStateFilter?: ScanStateFilter
  initialTargetFilter?: string
  /** Whether the active role may manage billing (drives recovery copy). */
  canManageBilling?: boolean
}

export function ScansClient({
  workspaceId,
  targets,
  initialData,
  initialNextCursor,
  initialShowCreate = false,
  initialTargetId = "",
  initialGoal,
  initialMode,
  initialStateFilter = "ALL",
  initialTargetFilter = "",
  canManageBilling = false,
}: ScansClientProps) {
  const [scans, setScans] = useState<ScanItem[]>(initialData)
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showCreate, setShowCreate] = useState(initialShowCreate)
  const [selectedTarget, setSelectedTarget] = useState(initialTargetId)
  const [selectedPreset, setSelectedPreset] = useState(() => {
    const target = targets.find((item) => item.id === initialTargetId)
    return findRecoveryPreset(
      getManualScanOptions({
        type: target?.type ?? "",
        hasApiSpec: Boolean(target?.apiSpecUrl),
      }),
      initialGoal,
      initialMode
    )
  })
  const [modeResetNotice, setModeResetNotice] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [pollStale, setPollStale] = useState(false)
  // Server-parsed URL filters; updated via replaceState and refetch.
  const [targetFilter, setTargetFilter] = useState(initialTargetFilter)
  const [stateFilter, setStateFilter] = useState<ScanStateFilter>(initialStateFilter)
  const [eligibility, setEligibility] = useState<EligibilityState>({ status: "idle" })

  const isDesktop = useMediaQuery("(min-width: 768px)")

  useScansWebMcp({
    workspaceId,
    targets,
    selectedPreset,
    setSelectedTarget,
    setSelectedPreset,
    setShowCreate,
    setModeResetNotice,
  })
  const scansRef = useRef(scans)
  const firstPageIdsRef = useRef(new Set(initialData.map((scan) => scan.id)))
  const firstPageHasMoreRef = useRef(initialNextCursor !== null)

  useEffect(() => {
    scansRef.current = scans
  }, [scans])

  const filteredParams = useCallback(
    (extra: Record<string, string> = {}) => ({
      workspaceId,
      ...(targetFilter ? { target: targetFilter } : {}),
      ...(stateFilter !== "ALL" ? { state: stateFilter } : {}),
      ...extra,
    }),
    [workspaceId, targetFilter, stateFilter]
  )

  const listParams = useCallback(
    (extra: Record<string, string> = {}) => ({
      workspaceId,
      ...(targetFilter ? { targetId: targetFilter } : {}),
      ...(stateFilter !== "ALL" ? { state: stateFilter } : {}),
      ...extra,
    }),
    [workspaceId, targetFilter, stateFilter]
  )

  function updateFilterUrl(next: { target?: string; state?: ScanStateFilter }) {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const nextTarget = next.target ?? targetFilter
    const nextState = next.state ?? stateFilter
    if (nextTarget) params.set("target", nextTarget)
    else params.delete("target")
    if (nextState !== "ALL") params.set("state", nextState)
    else params.delete("state")
    const search = params.toString()
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}`
    )
  }

  async function refetchFirstPage() {
    const result = await apiGetPaginated<ScanItem>("/api/scans", listParams(), {
      schema: scansPaginatedSchema,
    })
    setScans(result.items)
    setNextCursor(result.nextCursor)
    firstPageIdsRef.current = new Set(result.items.map((scan) => scan.id))
    firstPageHasMoreRef.current = result.nextCursor !== null
  }

  function handleTargetFilterChange(value: string) {
    setTargetFilter(value)
    updateFilterUrl({ target: value })
    setError(null)
    setErrorCode(null)
    refetchFirstPage().catch(() => setPollStale(true))
  }

  function handleStateFilterChange(value: string) {
    const next = parseScanStateFilter(value)
    setStateFilter(next)
    updateFilterUrl({ state: next })
    setError(null)
    setErrorCode(null)
    refetchFirstPage().catch(() => setPollStale(true))
  }

  async function handleCreateScan() {
    setErrorCode(null)
    if (!selectedTarget) {
      setError("Select a target to scan")
      return
    }
    if (!selectedOption) {
      setError("No review option is available for this target")
      return
    }
    setCreating(true)
    setError(null)
    try {
      const result = await apiPost(
        "/api/scans",
        {
          workspaceId,
          targetId: selectedTarget,
          goal: selectedOption.goal,
          mode: selectedOption.mode,
        },
        { schema: scanItemSchema }
      )
      setScans((prev) => [result, ...prev])
      setShowCreate(false)
      setSelectedTarget("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create scan")
      setErrorCode(err instanceof ApiError ? err.code : null)
    } finally {
      setCreating(false)
    }
  }

  async function handleCancelScan(scanId: string) {
    setCancelling(scanId)
    setError(null)
    setErrorCode(null)
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

  async function handleRemoveScan(scanId: string) {
    setRemoving(scanId)
    setError(null)
    setErrorCode(null)
    try {
      await apiDelete(`/api/scans/${scanId}?workspaceId=${encodeURIComponent(workspaceId)}`)
      setScans((prev) => prev.filter((scan) => scan.id !== scanId))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove scan")
    } finally {
      setRemoving(null)
    }
  }

  async function handleLoadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    setErrorCode(null)
    try {
      const result = await apiGetPaginated<ScanItem>(
        "/api/scans",
        listParams({ cursor: nextCursor }),
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
    setErrorCode(null)
    try {
      await refetchFirstPage()
      setPollStale(false)
    } catch {
      setPollStale(true)
    } finally {
      setRefreshing(false)
    }
  }

  const hasActiveScans = scans.some((scan) => isActiveScan(scan.status))
  const selectedTargetDetails = targets.find((target) => target.id === selectedTarget)
  const selectedTargetType = selectedTargetDetails?.type ?? ""
  const availableOptions = getManualScanOptions({
    type: selectedTargetType,
    hasApiSpec: Boolean(selectedTargetDetails?.apiSpecUrl),
  })
  const enabledOptions = availableOptions.filter((o) => o.available)
  const selectedOption = enabledOptions.find((o) => o.id === selectedPreset) ?? enabledOptions[0]
  const selectedTargetUsesEngine = selectedTargetType === "REPO"
  const reviewSetupGuidance = selectedTargetDetails
    ? getReviewSetupGuidance({
        targetId: selectedTargetDetails.id,
        targetType: selectedTargetType,
        hasApiSpec: Boolean(selectedTargetDetails.apiSpecUrl),
      })
    : null

  // ─── Eligibility preflight (advisory; POST re-checks authoritatively) ────

  useEffect(() => {
    if (!showCreate || !selectedTarget || !selectedOption) {
      // Deferred so the reset lands inside a callback, not the synchronous
      // effect body (avoids cascading renders).
      let cancelled = false
      const reset = () => {
        if (!cancelled) setEligibility({ status: "idle" })
      }
      if (typeof queueMicrotask === "function") queueMicrotask(reset)
      else setTimeout(reset, 0)
      return () => {
        cancelled = true
      }
    }
    const controller = new AbortController()
    // Deferred so the pending state lands inside a callback, not the
    // synchronous effect body (avoids cascading renders).
    let cancelled = false
    const schedule = () => {
      if (cancelled) return
      setEligibility({ status: "checking" })
      apiGet(
        `/api/scans/eligibility?${new URLSearchParams({
          workspaceId,
          targetId: selectedTarget,
          goal: selectedOption.goal,
          mode: selectedOption.mode,
        }).toString()}`,
        { schema: eligibilitySchema, signal: controller.signal }
      )
        .then((result) => {
          if (!controller.signal.aborted && result) {
            setEligibility({ status: "ready", eligibility: result })
          }
        })
        .catch((err) => {
          if (controller.signal.aborted) return
          if (err instanceof ApiError) {
            // Structured 4xx (e.g. invalid target) still carries a user-safe reason.
            setEligibility({
              status: "ready",
              eligibility: {
                allowed: false,
                code: err.code ?? "ELIGIBILITY_UNAVAILABLE",
                message: err.message,
                plan: "UNKNOWN",
                isTrial: false,
                remainingMinutes: 0,
              },
            })
          } else {
            setEligibility({ status: "error" })
          }
        })
    }
    if (typeof queueMicrotask === "function") queueMicrotask(schedule)
    else setTimeout(schedule, 0)
    return () => {
      cancelled = true
      controller.abort()
    }
    // selectedOption is derived from a freshly-built options array each render,
    // so the effect keys on its identity fields instead of the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreate, workspaceId, selectedTarget, selectedOption?.goal, selectedOption?.mode])

  const eligibilityBlocked = eligibility.status === "ready" && !eligibility.eligibility.allowed
  const startDisabled =
    creating ||
    !selectedTarget ||
    !selectedOption ||
    eligibility.status === "checking" ||
    eligibilityBlocked

  function handleSelectTarget(targetId: string) {
    setSelectedTarget(targetId)
    if (!targetId) {
      setSelectedPreset("")
      setModeResetNotice(null)
      return
    }
    const target = targets.find((t) => t.id === targetId)
    const options = getManualScanOptions({
      type: target?.type ?? "",
      hasApiSpec: Boolean(target?.apiSpecUrl),
    })
    const currentStillAvailable = options.find((o) => o.id === selectedPreset && o.available)
    if (currentStillAvailable) {
      setModeResetNotice(null)
      return
    }
    const firstAvailable = options.find((o) => o.available)
    if (firstAvailable) {
      setSelectedPreset(firstAvailable.id)
      setModeResetNotice(
        selectedPreset
          ? `Review type reset to ${firstAvailable.label} because the previous choice is not available for this target.`
          : null
      )
    } else {
      setSelectedPreset("")
      setModeResetNotice(null)
    }
  }

  useEffect(() => {
    if (!hasActiveScans) return
    // SSR safety: the polling loop touches `document`; never assume a DOM.
    if (typeof document === "undefined") return
    const controller = new AbortController()
    let timeoutId: number | undefined
    let isAborted = false
    let pollEtag: string | undefined
    const pollStartedAt = Date.now()

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

    // Battery/network: while the tab is hidden the poll loop suspends entirely
    // — no timer spin and no requests. `onVisibility` below resumes it with one
    // immediate refetch when the tab becomes visible, so the list catches up
    // right away instead of waiting out the (up to 60s) backoff interval.
    const poll = async () => {
      if (document.hidden) return
      try {
        // Poll the bounded first page so a scan's terminal state replaces its
        // previous active row. The ETag from the previous tick makes an
        // unchanged list a bodyless 304.
        const { data, etag } = await apiGetPaginatedConditional("/api/scans", filteredParams(), {
          signal: controller.signal,
          schema: scansPaginatedSchema,
          ...(pollEtag ? { etag: pollEtag } : {}),
        })
        if (etag) pollEtag = etag
        if (data) {
          firstPageIdsRef.current = new Set(data.items.map((scan) => scan.id))
          firstPageHasMoreRef.current = data.nextCursor !== null
        }

        const unfiltered = stateFilter === "ALL" && !targetFilter
        const missingIds = unfiltered
          ? missingActiveScanIds(
              scansRef.current,
              firstPageIdsRef.current,
              firstPageHasMoreRef.current
            )
          : []
        const resolvedMissing = missingIds.length
          ? await apiGetPaginated<ScanItem>(
              "/api/scans",
              { workspaceId, ids: missingIds.join(",") },
              { signal: controller.signal, schema: scansPaginatedSchema }
            )
          : null

        setPollStale(false)
        if (!controller.signal.aborted && (data || resolvedMissing)) {
          setScans((current) => {
            if (!unfiltered) {
              // A filtered view replaces its page wholesale: rows that no
              // longer match the filter must not linger from a previous page.
              return data ? data.items : current
            }
            let merged = data
              ? mergePolledScans(current, data.items, { hasMore: data.nextCursor !== null })
              : current
            if (!resolvedMissing) return merged
            return mergeResolvedOffPageScans(merged, resolvedMissing.items, missingIds)
          })
        }
      } catch {
        if (!controller.signal.aborted) setPollStale(true)
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
  }, [hasActiveScans, workspaceId, filteredParams, stateFilter, targetFilter])

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={`Filter by ${TARGET_SINGULAR.toLowerCase()}`}
            value={targetFilter}
            onChange={(e) => handleTargetFilterChange(e.target.value)}
            className="h-9 w-44"
          >
            <option value="">All {TARGET_PLURAL.toLowerCase()}</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by state"
            value={stateFilter}
            onChange={(e) => handleStateFilterChange(e.target.value)}
            className="h-9 w-40"
          >
            {SCAN_STATE_FILTERS.map((state) => (
              <option key={state} value={state}>
                {scanStateStatusLabel(state)}
              </option>
            ))}
          </Select>
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
            <Button onClick={() => setShowCreate(true)}>
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
          <span>{safeApiErrorMessage(error)}</span>
          {(isBillingRecoveryCode(errorCode) ||
            (eligibilityBlocked &&
              isBillingRecoveryCode(
                eligibility.status === "ready" ? eligibility.eligibility.code : null
              ))) && <BillingRecoveryLink canManageBilling={canManageBilling} />}
        </div>
      )}

      {pollStale && (
        <div
          role="status"
          className="border-amber-500/50 bg-amber-500/10 mb-4 flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <span>Updates are paused. The displayed scan status may be stale.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing" : "Try again"}
          </Button>
        </div>
      )}

      {/* Composer sheet: right-side on desktop, full-height bottom sheet on mobile. */}
      <Sheet open={showCreate} onOpenChange={setShowCreate}>
        <SheetContent
          side={isDesktop ? "right" : "bottom"}
          className={cn(
            "flex flex-col gap-0 p-0",
            isDesktop
              ? "w-full max-w-xl sm:max-w-xl"
              : "h-[92vh] max-h-[92vh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
          )}
        >
          <SheetHeader className="border-b px-6 py-4 text-left">
            <SheetTitle>Start a {RUN_SINGULAR.toLowerCase()}</SheetTitle>
            <SheetDescription>
              Choose a {TARGET_SINGULAR.toLowerCase()} and how thorough the review should be.
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-5">
              <FormField label={TARGET_SINGULAR} htmlFor="scan-target">
                <Select
                  id="scan-target"
                  value={selectedTarget}
                  onChange={(e) => handleSelectTarget(e.target.value)}
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
                  <span className="text-muted-foreground text-[11px]">
                    Simple options: pick one
                  </span>
                </div>

                <div role="radiogroup" aria-label="Review type" className="grid grid-cols-1 gap-3">
                  {availableOptions.map((option) => {
                    const isSelected = selectedOption?.id === option.id
                    const isDisabled = !option.available
                    return (
                      <button
                        key={option.id}
                        id={`preset-${option.id}`}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        aria-disabled={isDisabled}
                        aria-label={`${option.label}: ${option.description}${isDisabled ? ` (${option.disabledReason})` : ""}`}
                        tabIndex={isSelected ? 0 : -1}
                        disabled={isDisabled}
                        onClick={() => !isDisabled && setSelectedPreset(option.id)}
                        onKeyDown={(e) => {
                          if (isDisabled) return
                          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                            e.preventDefault()
                            const idx = enabledOptions.findIndex((o) => o.id === option.id)
                            const next = enabledOptions[(idx + 1) % enabledOptions.length]
                            if (next) {
                              setSelectedPreset(next.id)
                              document.getElementById(`preset-${next.id}`)?.focus()
                            }
                          }
                          if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                            e.preventDefault()
                            const idx = enabledOptions.findIndex((o) => o.id === option.id)
                            const prev =
                              enabledOptions[
                                (idx - 1 + enabledOptions.length) % enabledOptions.length
                              ]
                            if (prev) {
                              setSelectedPreset(prev.id)
                              document.getElementById(`preset-${prev.id}`)?.focus()
                            }
                          }
                        }}
                        className={cn(
                          "group focus-visible:ring-ring relative flex min-h-23 w-full flex-col items-start rounded-lg border p-4 text-left shadow-xs transition-[border-color,box-shadow,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                          isDisabled
                            ? "opacity-60 cursor-not-allowed bg-muted/40 border-dashed"
                            : isSelected
                              ? "border-primary bg-primary/6 dark:bg-primary/12 ring-primary/20 shadow-sm ring-1"
                              : "border-border bg-card hover:border-border/80 hover:bg-accent/50"
                        )}
                      >
                        <div className="flex w-full items-center justify-between gap-2">
                          <span className="text-sm font-semibold tracking-tight">
                            {option.label}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <Badge
                              variant={modeBadgeVariant(option.mode)}
                              className="px-2 py-0 text-[10px] font-semibold tracking-wide uppercase"
                            >
                              {option.mode}
                            </Badge>
                            {isSelected ? (
                              <span className="bg-primary text-primary-foreground inline-flex size-5 items-center justify-center rounded-full">
                                <Check className="size-3" aria-hidden="true" />
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <span className="text-muted-foreground mt-1.5 line-clamp-3 text-xs leading-relaxed">
                          {option.description}
                        </span>
                        {isDisabled && option.disabledReason ? (
                          <span className="mt-2 text-[11px] text-amber-600">
                            {option.disabledReason}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>

                <p className="text-muted-foreground mt-2 text-xs">
                  {selectedOption?.hint}{" "}
                  {selectedTarget && !selectedTargetUsesEngine
                    ? "This target uses deterministic scanners."
                    : "Your selected review sets the scope automatically."}
                </p>
                {modeResetNotice && (
                  <p className="text-amber-600 mt-2 text-xs" role="status" aria-live="polite">
                    {modeResetNotice}
                  </p>
                )}
                {reviewSetupGuidance && (
                  <div
                    className="border-primary/20 bg-primary/5 mt-3 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                    role="status"
                    aria-live="polite"
                  >
                    <p className="text-sm leading-relaxed">{reviewSetupGuidance.message}</p>
                    <Link
                      href={reviewSetupGuidance.href}
                      className="text-primary hover:text-primary/80 focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-1 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none"
                    >
                      {reviewSetupGuidance.actionLabel}
                      <ChevronRight className="size-4" aria-hidden="true" />
                    </Link>
                  </div>
                )}
              </div>

              {/* Time and eligibility — always bounded, never silently permissive. */}
              <div aria-live="polite">
                <p className="mb-2 block text-sm font-medium">Time and eligibility</p>
                {!selectedTarget || !selectedOption ? (
                  <p className="text-muted-foreground rounded-lg border p-3 text-sm">
                    Select a target and review type to see the estimate and your remaining agent
                    minutes.
                  </p>
                ) : eligibility.status === "checking" ? (
                  <div className="space-y-2 rounded-lg border p-3" aria-busy="true">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-4 w-56" />
                  </div>
                ) : eligibility.status === "error" ? (
                  <div className="border-amber-500/50 bg-amber-500/10 rounded-lg border p-3 text-sm">
                    <p className="flex items-center gap-2">
                      <AlertCircle className="text-amber-600 size-4 shrink-0" aria-hidden="true" />
                      Eligibility could not be checked. Start stays disabled until it loads.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => setEligibility({ status: "checking" })}
                    >
                      Retry check
                    </Button>
                  </div>
                ) : eligibility.status === "ready" && eligibility.eligibility.allowed ? (
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="flex items-center gap-1.5 font-medium">
                        <Clock className="text-muted-foreground size-4" aria-hidden="true" />
                        Est. time: {formatEstimate(selectedOption.estimate)}
                      </span>
                      <span className="text-muted-foreground">
                        Remaining agent minutes:{" "}
                        <span className="text-foreground font-medium">
                          {eligibility.eligibility.remainingMinutes}
                        </span>
                        {eligibility.eligibility.isTrial ? " (trial)" : ""}
                      </span>
                    </p>
                  </div>
                ) : eligibility.status === "ready" ? (
                  <div
                    className="border-destructive/40 bg-destructive/5 rounded-lg border p-3 text-sm"
                    role="alert"
                  >
                    <p className="font-medium">This review cannot start yet</p>
                    <p className="text-muted-foreground mt-1">
                      {eligibility.eligibility.message ?? "Not allowed for this workspace."}
                    </p>
                    {isBillingRecoveryCode(eligibility.eligibility.code) && (
                      <p className="mt-2">
                        {canManageBilling ? (
                          <Link
                            href="/dashboard/billing"
                            className="text-primary inline-flex min-h-11 items-center gap-1 font-medium hover:underline"
                          >
                            Review billing options
                            <ChevronRight className="size-4" aria-hidden="true" />
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            Ask a workspace owner to review billing options.
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                ) : null}
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
                  What this covers
                </button>

                {showAdvanced && selectedOption && (
                  <div
                    id="scan-advanced-panel"
                    className="bg-muted/40 border-border mt-2 rounded-lg border p-4"
                  >
                    <div className="space-y-3">
                      <div>
                        <p className="text-sm font-medium">What this review covers</p>
                        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                          {selectedOption.hint}
                        </p>
                      </div>
                      <p className="text-muted-foreground text-[11px] leading-relaxed">
                        The completed run records the applicable evidence and any limitations so you
                        can decide what to fix or retest next.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex gap-2 border-t px-6 py-4">
            <Button onClick={handleCreateScan} disabled={startDisabled} className="min-h-11 flex-1">
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
        </SheetContent>
      </Sheet>

      {refreshing && scans.length === 0 ? (
        <div
          className="space-y-3"
          aria-busy="true"
          aria-label={`Loading ${RUN_PLURAL.toLowerCase()}`}
        >
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-20 w-full" />
          ))}
        </div>
      ) : scans.length === 0 ? (
        <EmptyState
          icon={Radar}
          title={
            targetFilter || stateFilter !== "ALL"
              ? `No ${RUN_PLURAL.toLowerCase()} match these filters`
              : `No ${RUN_PLURAL.toLowerCase()} yet`
          }
          description={
            targetFilter || stateFilter !== "ALL"
              ? "Try a different target or state filter."
              : targets.length > 0
                ? `Start your first ${RUN_SINGULAR.toLowerCase()} with "New ${RUN_SINGULAR}".`
                : `Add a ${TARGET_SINGULAR.toLowerCase()} first, then you can run ${RUN_PLURAL.toLowerCase()} against it.`
          }
          action={
            targetFilter || stateFilter !== "ALL" ? (
              <Button
                variant="outline"
                onClick={() => {
                  handleTargetFilterChange("")
                  handleStateFilterChange("ALL")
                }}
              >
                Clear filters
              </Button>
            ) : targets.length > 0 ? (
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
        <div className="space-y-2">
          {scans.map((scan) => {
            const presentation = getScanPresentation(scan.status, {
              errorCategory: scan.errorCategory,
              errorMessage: scan.errorMessage,
            })
            const active = isActiveScan(scan.status)
            const needsAttention = ["FAILED", "STOPPED_BUDGET", "TIMED_OUT"].includes(scan.status)
            return (
              <Card key={scan.id} className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={presentation.badgeVariant}>{presentation.label}</Badge>
                      <Link
                        href={`/dashboard/scans/${scan.id}`}
                        className="truncate text-sm font-medium hover:underline"
                      >
                        {scan.target?.name ?? "Workspace scan"}
                      </Link>
                      <span className="text-muted-foreground text-xs">
                        {modeLabel(scan.mode)} · {getGoalLabel(scan.goal)}
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span className="whitespace-nowrap">{formatDateTime(scan.createdAt)}</span>
                      {scan.endedAt && (
                        <span className="whitespace-nowrap">
                          · completed {formatDateTime(scan.endedAt)}
                        </span>
                      )}
                      {scan.findingCount !== undefined && scan.findingCount > 0 && (
                        <span className="text-foreground font-medium whitespace-nowrap">
                          {scan.findingCount} issue{scan.findingCount !== 1 ? "s" : ""} from this
                          run
                        </span>
                      )}
                    </div>
                    {scan.errorMessage && presentation.showFailureDetails && (
                      <p className="text-destructive line-clamp-1 text-xs wrap-break-word">
                        {safeApiErrorMessage(scan.errorMessage)}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {active &&
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
                          confirmLabel="Stop run"
                          message="Stop this run?"
                          aria-label="Cancel this run"
                          onConfirm={() => handleCancelScan(scan.id)}
                        />
                      ))}
                    {!active && needsAttention && scan.target && (
                      <Link
                        href={scanRecoveryHref({
                          targetId: scan.target.id,
                          goal: scan.goal,
                          mode: scan.mode,
                        })}
                        aria-label={`Retry setup for ${scan.target?.name ?? "run"}`}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        <RotateCcw className="mr-1 h-4 w-4" aria-hidden="true" />
                        Retry
                      </Link>
                    )}
                    {!active &&
                      !needsAttention &&
                      (removing === scan.id ? (
                        <Button variant="ghost" size="sm" disabled aria-label="Removing run">
                          <Spinner className="h-4 w-4" />
                        </Button>
                      ) : (
                        <InlineConfirm
                          triggerIcon={<Trash2 className="h-4 w-4" aria-hidden="true" />}
                          aria-label="Remove run"
                          message="Remove this run from the workspace?"
                          confirmLabel="Remove"
                          onConfirm={() => handleRemoveScan(scan.id)}
                        />
                      ))}
                    <Link
                      href={`/dashboard/scans/${scan.id}`}
                      aria-label={`Open details for ${scan.target?.name ?? "run"}`}
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

function BillingRecoveryLink({ canManageBilling }: { canManageBilling: boolean }) {
  if (canManageBilling) {
    return (
      <Link href="/dashboard/billing" className="ml-2 underline underline-offset-4">
        Review billing options
      </Link>
    )
  }
  return (
    <span className="text-muted-foreground ml-2">
      Ask a workspace owner to review billing options.
    </span>
  )
}
