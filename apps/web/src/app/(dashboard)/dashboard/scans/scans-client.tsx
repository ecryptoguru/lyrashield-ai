"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useScansWebMcp } from "./scans-webmcp"
import { useActiveScansPolling } from "./use-active-scans-polling"
import { CreateScanSheet } from "./create-scan-sheet"
import { ScanList } from "./scan-list"
import Link from "next/link"
import { Play, RefreshCw } from "lucide-react"
import { Button, Select } from "@lyrashield/ui"
import {
  scanCancelSchema,
  scanEligibilitySchema,
  scanItemSchema,
  scansPaginatedSchema,
} from "@/lib/api-schemas"
import { ApiError, apiDelete, apiPost, apiGet, apiGetPaginated } from "@/lib/api-client"
import { RUN_SINGULAR, TARGET_PLURAL, TARGET_SINGULAR } from "@/lib/terminology"
import {
  findRecoveryPreset,
  getReviewSetupGuidance,
  isBillingRecoveryCode,
} from "./scans-client.utils"
import {
  isActiveScan,
  SCAN_STATE_FILTERS,
  parseScanStateFilter,
  scanStateStatusLabel,
  type ScanStateFilter,
} from "@/lib/scan-presentation"
import { getManualScanOptions } from "@/lib/scan-presets"
import { safeApiErrorMessage } from "@/components/api-error-card"
import type { ScanEligibilityState, ScanItem, TargetItem } from "./scan-types"

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
  const reviewChoiceVersion = useRef(0)
  // One active target and no explicit selection: preselect it. Choosing among
  // several is the user's call, but being asked to pick the only option is not.
  const initialSelectedTarget = initialTargetId || (targets.length === 1 ? targets[0]!.id : "")
  const [selectedTarget, setSelectedTarget] = useState(initialSelectedTarget)
  const [selectedFocus, setSelectedFocus] = useState<string | null>(null)
  const [selectedPreset, setSelectedPreset] = useState(() => {
    const target = targets.find((item) => item.id === initialSelectedTarget)
    return findRecoveryPreset(
      getManualScanOptions({
        type: target?.type ?? "",
        hasApiSpec: Boolean(target?.apiSpecUrl),
      }),
      initialGoal,
      initialMode
    )
  })
  const choosePreset = useCallback((id: string) => {
    reviewChoiceVersion.current++
    setSelectedPreset(id)
  }, [])
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
  const [eligibility, setEligibility] = useState<ScanEligibilityState>({ status: "idle" })
  const [eligibilityAttempt, setEligibilityAttempt] = useState(0)
  const [startingTrial, setStartingTrial] = useState(false)

  const isDesktop = useMediaQuery("(min-width: 768px)")

  useScansWebMcp({
    workspaceId,
    targets,
    selectedPreset,
    setSelectedTarget,
    setSelectedPreset: choosePreset,
    setShowCreate,
    setModeResetNotice,
  })
  const scansRef = useRef(scans)
  const firstPageIdsRef = useRef(new Set(initialData.map((scan) => scan.id)))
  const firstPageHasMoreRef = useRef(initialNextCursor !== null)

  useEffect(() => {
    scansRef.current = scans
  }, [scans])

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

  async function refetchFirstPage(
    nextTarget = targetFilter,
    nextState: ScanStateFilter = stateFilter
  ) {
    const result = await apiGetPaginated<ScanItem>(
      "/api/scans",
      {
        workspaceId,
        ...(nextTarget ? { targetId: nextTarget } : {}),
        ...(nextState !== "ALL" ? { state: nextState } : {}),
      },
      {
        schema: scansPaginatedSchema,
      }
    )
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
    refetchFirstPage(value, stateFilter).catch(() => setPollStale(true))
  }

  function handleStateFilterChange(value: string) {
    const next = parseScanStateFilter(value)
    setStateFilter(next)
    updateFilterUrl({ state: next })
    setError(null)
    setErrorCode(null)
    refetchFirstPage(targetFilter, next).catch(() => setPollStale(true))
  }

  function handleClearFilters() {
    setTargetFilter("")
    setStateFilter("ALL")
    updateFilterUrl({ target: "", state: "ALL" })
    setError(null)
    setErrorCode(null)
    refetchFirstPage("", "ALL").catch(() => setPollStale(true))
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
          ...(selectedFocus ? { focus: selectedFocus } : {}),
        },
        { schema: scanItemSchema }
      )
      setScans((prev) => [result, ...prev])
      setShowCreate(false)
      setSelectedFocus(null)
      // Clear back to the preselect default (the sole target when there is
      // exactly one) rather than an unconditional blank.
      setSelectedTarget(initialSelectedTarget)
      setSelectedPreset(() => {
        const target = targets.find((item) => item.id === initialSelectedTarget)
        if (!target) return ""
        const options = getManualScanOptions({
          type: target.type,
          hasApiSpec: Boolean(target.apiSpecUrl),
        })
        return options.find((o) => o.available)?.id ?? ""
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create scan")
      setErrorCode(err instanceof ApiError ? err.code : null)
    } finally {
      setCreating(false)
    }
  }

  async function handleStartTrial() {
    setStartingTrial(true)
    setError(null)
    try {
      await apiPost("/api/billing/trial/start", { workspaceId })
      setEligibilityAttempt((attempt) => attempt + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start your trial.")
    } finally {
      setStartingTrial(false)
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
        { schema: scanEligibilitySchema, signal: controller.signal }
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
  }, [
    showCreate,
    workspaceId,
    selectedTarget,
    selectedOption?.goal,
    selectedOption?.mode,
    eligibilityAttempt,
  ])

  const eligibilityBlocked = eligibility.status === "ready" && !eligibility.eligibility.allowed
  const startDisabled =
    creating ||
    !selectedTarget ||
    !selectedOption ||
    eligibility.status === "checking" ||
    eligibility.status === "error" ||
    eligibilityBlocked

  function handleSelectTarget(targetId: string) {
    const choiceVersion = ++reviewChoiceVersion.current
    if (targetId) {
      void apiGet(
        "/api/scans?" +
          new URLSearchParams({ workspaceId, targetId, status: "COMPLETED", limit: "1" }),
        {
          schema: scansPaginatedSchema,
        }
      )
        .then((history) => {
          if (choiceVersion !== reviewChoiceVersion.current) return
          const latest = history.items[0]
          const target = targets.find((item) => item.id === targetId)
          const options = getManualScanOptions({
            type: target?.type ?? "",
            hasApiSpec: Boolean(target?.apiSpecUrl),
          })
          const remembered = latest ? findRecoveryPreset(options, latest.goal, latest.mode) : ""
          if (remembered && options.some((option) => option.id === remembered && option.available))
            setSelectedPreset(remembered)
        })
        .catch(() => {
          /* Advisory preference lookup; eligibility remains authoritative. */
        })
    }
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

  useActiveScansPolling({
    hasActiveScans,
    workspaceId,
    listParams,
    stateFilter,
    targetFilter,
    scansRef,
    firstPageIdsRef,
    firstPageHasMoreRef,
    setScans,
    setPollStale,
  })

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
      <CreateScanSheet
        open={showCreate}
        onOpenChange={setShowCreate}
        isDesktop={isDesktop}
        errorCode={errorCode}
        targets={targets}
        selectedTarget={selectedTarget}
        handleSelectTarget={handleSelectTarget}
        availableOptions={availableOptions}
        enabledOptions={enabledOptions}
        selectedOption={selectedOption}
        choosePreset={choosePreset}
        modeResetNotice={modeResetNotice}
        selectedFocus={selectedFocus}
        setSelectedFocus={setSelectedFocus}
        reviewSetupGuidance={reviewSetupGuidance}
        eligibility={eligibility}
        setEligibilityAttempt={setEligibilityAttempt}
        canManageBilling={canManageBilling}
        startingTrial={startingTrial}
        handleStartTrial={handleStartTrial}
        startDisabled={startDisabled}
        creating={creating}
        handleCreateScan={handleCreateScan}
        showAdvanced={showAdvanced}
        setShowAdvanced={setShowAdvanced}
      />

      <ScanList
        scans={scans}
        refreshing={refreshing}
        nextCursor={nextCursor}
        loadingMore={loadingMore}
        targetFilter={targetFilter}
        stateFilter={stateFilter}
        hasTargets={targets.length > 0}
        onClearFilters={handleClearFilters}
        onShowCreate={() => setShowCreate(true)}
        cancelling={cancelling}
        removing={removing}
        onCancelScan={handleCancelScan}
        onRemoveScan={handleRemoveScan}
        onLoadMore={handleLoadMore}
      />
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
