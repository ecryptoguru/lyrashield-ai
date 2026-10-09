"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useScansWebMcp } from "./scans-webmcp"
import { useScanListState } from "./use-scan-list-state"
import { CreateScanSheet } from "./create-scan-sheet"
import { resolveScanSubmissionFailure } from "./scan-submission-failure"
import { ScanList } from "./scan-list"
import { ScanStatusNotices } from "./scan-status-notices"
import { Play, RefreshCw } from "lucide-react"
import { z } from "zod"
import { Button, Select } from "@lyrashield/ui"
import {
  scanAttachmentListSchema,
  scanEligibilitySchema,
  scanItemSchema,
  scansPaginatedSchema,
  type ScanAttachmentItem,
} from "@/lib/api-schemas"
import { ApiError, apiPost, apiGet } from "@/lib/api-client"
import { SCAN_SINGULAR, TARGET_PLURAL, TARGET_SINGULAR } from "@/lib/terminology"
import { findRecoveryPreset, getReviewSetupGuidance, scanRecoveryHref } from "./scans-client.utils"
import {
  SCAN_STATE_FILTERS,
  scanStateStatusLabel,
  type ScanStateFilter,
} from "@/lib/scan-presentation"
import { getDefaultScanOptionId, getManualScanOptions } from "@/lib/scan-presets"
import { safeApiErrorMessage } from "@/components/api-error-card"
import type { ScanEligibilityState, ScanItem, TargetItem } from "./scan-types"
import {
  beginScanSubmission,
  clearPendingScanSubmission,
  readPendingScanSubmission,
  recordAcceptedScan,
  runScanSubmission,
  scanOperationStatusSchema,
  scanRequestIdentity,
  type PendingScanSubmission,
  type ScanOperationStatus,
  type ScanSubmissionScope,
} from "@/lib/scan-submission"

const scanCreateResponseSchema = scanItemSchema.extend({ operationId: z.string().optional() })

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
  principalId: string
  workspaceId: string
  targets: TargetItem[]
  initialData: ScanItem[]
  initialNextCursor: string | null
  initialShowCreate?: boolean
  initialTargetId?: string
  initialRecoveryUnavailable?: boolean
  initialGoal?: string
  initialMode?: string
  /** Server-parsed URL filter state — never re-read from window here. */
  initialStateFilter?: ScanStateFilter
  initialTargetFilter?: string
  initialFilterUnavailable?: boolean
  /** Whether the active role may manage billing (drives recovery copy). */
  canManageBilling?: boolean
}

export function ScansClient({
  principalId,
  workspaceId,
  targets,
  initialData,
  initialNextCursor,
  initialShowCreate = false,
  initialTargetId = "",
  initialRecoveryUnavailable = false,
  initialGoal,
  initialMode,
  initialStateFilter = "ALL",
  initialTargetFilter = "",
  initialFilterUnavailable = false,
  canManageBilling = false,
}: ScansClientProps) {
  const router = useRouter()
  const [showCreate, setShowCreate] = useState(initialShowCreate)
  const reviewChoiceVersion = useRef(0)
  // One active target and no explicit selection: preselect it. Choosing among
  // several is the user's call, but being asked to pick the only option is not.
  const initialSelectedTarget = initialTargetId || (targets.length === 1 ? targets[0]!.id : "")
  const [selectedTarget, setSelectedTarget] = useState(initialSelectedTarget)
  const [selectedFocus, setSelectedFocus] = useState<string | null>(null)
  const [selectedPreset, setSelectedPreset] = useState(() => {
    const target = targets.find((item) => item.id === initialSelectedTarget)
    const options = getManualScanOptions({
      type: target?.type ?? "",
      hasApiSpec: Boolean(target?.apiSpecUrl),
    })
    return findRecoveryPreset(options, initialGoal, initialMode) || getDefaultScanOptionId(options)
  })
  // Review Changes revision inputs — resolved to immutable SHAs server-side.
  const [baseRef, setBaseRef] = useState("")
  const [headRef, setHeadRef] = useState("")
  const [attachments, setAttachments] = useState<ScanAttachmentItem[]>([])
  const [selectedAttachments, setSelectedAttachments] = useState<string[]>([])
  const choosePreset = useCallback((id: string) => {
    reviewChoiceVersion.current++
    setSelectedPreset(id)
  }, [])
  const [modeResetNotice, setModeResetNotice] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(
    initialRecoveryUnavailable ? "This target is no longer available. Choose another target." : null
  )
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const {
    scans,
    setScans,
    nextCursor,
    loadingMore,
    refreshing,
    pollStale,
    pagesReset,
    targetFilter,
    stateFilter,
    cancelling,
    removing,
    handleTargetFilterChange,
    handleStateFilterChange,
    handleClearFilters,
    handleCancelScan,
    handleRemoveScan,
    handleLoadMore,
    handleRefresh,
  } = useScanListState({
    workspaceId,
    initialData,
    initialNextCursor,
    initialTargetFilter,
    initialStateFilter,
    setError,
    setErrorCode,
  })
  const [eligibility, setEligibility] = useState<ScanEligibilityState>({ status: "idle" })
  const [eligibilityAttempt, setEligibilityAttempt] = useState(0)
  const [startingTrial, setStartingTrial] = useState(false)
  const scanSubmissionLock = useRef({ current: false })
  const scopeGenerationRef = useRef(0)
  const operationRequestRef = useRef(0)
  const errorScopeRef = useRef({ principalId, workspaceId })
  const [pendingScanSubmission, setPendingScanSubmission] = useState<PendingScanSubmission | null>(
    null
  )
  const [scanOperationStatus, setScanOperationStatus] = useState<ScanOperationStatus | null>(null)
  const [checkingScanOperation, setCheckingScanOperation] = useState(false)
  const [scanRecoveryError, setScanRecoveryError] = useState<string | null>(null)
  const [scanRecoveryUnavailable, setScanRecoveryUnavailable] = useState(false)
  const [forceNewAfterRecovery, setForceNewAfterRecovery] = useState(false)

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
  async function handleCreateScan(startNewScan = false) {
    const scopeGeneration = scopeGenerationRef.current
    const isCurrentScope = () => scopeGeneration === scopeGenerationRef.current
    setErrorCode(null)
    if (!selectedTarget) {
      setError("Select a target to scan")
      return
    }
    if (!selectedOption) {
      setError("No review option is available for this target")
      return
    }
    if (selectedOption.requiresRevisionInputs && !baseRef.trim()) {
      setError("Enter the base revision to compare against")
      return
    }
    if (!createScanRequest) {
      setError("No review option is available for this target")
      return
    }

    await runScanSubmission(scanSubmissionLock.current, async () => {
      setCreating(true)
      if (startNewScan) setForceNewAfterRecovery(false)
      setError(null)
      setScanRecoveryError(null)
      try {
        if (startNewScan) {
          const existing = readPendingScanSubmission(scanSubmissionScope)
          if (existing?.state === "accepted") {
            setPendingScanSubmission(existing)
            setError("This scan was already accepted. Open it before starting another scan.")
            return
          }
          if (existing) {
            clearPendingScanSubmission(scanSubmissionScope, existing.idempotencyKey)
          }
        }
        let begun = beginScanSubmission(scanSubmissionScope, createScanRequest)
        if (begun.kind === "conflict") {
          setPendingScanSubmission(begun.submission)
          if (!startNewScan || begun.submission.state === "accepted") {
            setScanRecoveryError(
              "A previous scan may still be starting. Check its status or explicitly start a new scan."
            )
            return
          }
          clearPendingScanSubmission(scanSubmissionScope, begun.submission.idempotencyKey)
          begun = beginScanSubmission(scanSubmissionScope, createScanRequest)
        }

        let submission = begun.submission
        setPendingScanSubmission(submission)
        if (submission.state === "accepted" && submission.scanId) {
          router.push(`/dashboard/scans/${encodeURIComponent(submission.scanId)}`)
          setShowCreate(false)
          return
        }
        if (submission.operationId) {
          await checkPendingScanOperation(submission)
          return
        }

        let result: z.infer<typeof scanCreateResponseSchema>
        try {
          result = await apiPost("/api/scans", createScanRequest, {
            schema: scanCreateResponseSchema,
            headers: { "Idempotency-Key": submission.idempotencyKey },
          })
        } catch (err) {
          const failure = resolveScanSubmissionFailure({
            scope: scanSubmissionScope,
            submission,
            error: err,
          })
          if (!isCurrentScope()) return
          if (failure.recoveryUnavailable) setScanRecoveryUnavailable(true)
          setPendingScanSubmission(failure.pendingSubmission)
          setError(err instanceof Error ? err.message : "Failed to create scan")
          setErrorCode(err instanceof ApiError ? err.code : null)
          setScanRecoveryError(failure.recoveryError)
          return
        }

        const operationId = typeof result.operationId === "string" ? result.operationId : undefined
        const accepted = {
          ...submission,
          state: "accepted" as const,
          scanId: result.id,
          ...(operationId ? { operationId } : {}),
        }
        try {
          recordAcceptedScan(scanSubmissionScope, submission.idempotencyKey, result.id, operationId)
        } catch (cause) {
          if (!isCurrentScope()) return
          setScanRecoveryUnavailable(true)
          setScanRecoveryError(
            cause instanceof Error
              ? cause.message
              : "Scan accepted; recovery details could not be saved."
          )
        }
        // A late acceptance remains saved under its original scope for recovery.
        if (!isCurrentScope()) return
        setPendingScanSubmission(accepted)
        setScans((prev) => (prev.some((scan) => scan.id === result.id) ? prev : [result, ...prev]))
        try {
          clearPendingScanSubmission(scanSubmissionScope, submission.idempotencyKey)
          setPendingScanSubmission(null)
        } catch (cause) {
          if (!isCurrentScope()) return
          setScanRecoveryUnavailable(true)
          setScanRecoveryError(
            cause instanceof Error
              ? cause.message
              : "Saved scan recovery data could not be cleared."
          )
        }
        setShowCreate(false)
        router.push(`/dashboard/scans/${encodeURIComponent(result.id)}`)
        setSelectedFocus(null)
        setBaseRef("")
        setHeadRef("")
        setSelectedAttachments([])
        setSelectedTarget(initialSelectedTarget)
        setSelectedPreset(() => {
          const target = targets.find((item) => item.id === initialSelectedTarget)
          if (!target) return ""
          const options = getManualScanOptions({
            type: target.type,
            hasApiSpec: Boolean(target.apiSpecUrl),
          })
          return getDefaultScanOptionId(options)
        })
        setForceNewAfterRecovery(false)
      } catch (err) {
        if (!isCurrentScope()) return
        setScanRecoveryUnavailable(true)
        setScanRecoveryError(
          err instanceof Error ? err.message : "Could not save scan recovery information."
        )
      } finally {
        if (isCurrentScope()) setCreating(false)
      }
    })
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

  const selectedTargetDetails = targets.find((target) => target.id === selectedTarget)
  const selectedTargetType = selectedTargetDetails?.type ?? ""
  const availableOptions = getManualScanOptions({
    type: selectedTargetType,
    hasApiSpec: Boolean(selectedTargetDetails?.apiSpecUrl),
  })
  const enabledOptions = availableOptions.filter((o) => o.available)
  const selectedOption =
    enabledOptions.find((o) => o.id === selectedPreset) ??
    enabledOptions.find((o) => o.id === getDefaultScanOptionId(availableOptions)) ??
    enabledOptions[0]
  const reviewSetupGuidance = selectedTargetDetails
    ? getReviewSetupGuidance({
        targetId: selectedTargetDetails.id,
        targetType: selectedTargetType,
        hasApiSpec: Boolean(selectedTargetDetails.apiSpecUrl),
      })
    : null

  const scanSubmissionScope: ScanSubmissionScope = {
    principalId,
    workspaceId,
    surface: "dashboard",
  }
  const createScanRequest =
    selectedTarget && selectedOption
      ? {
          workspaceId,
          targetId: selectedTarget,
          goal: selectedOption.goal,
          mode: selectedOption.mode,
          ...(selectedOption.workflow !== "REVIEW_TARGET"
            ? { workflow: selectedOption.workflow }
            : {}),
          ...(selectedOption.requiresRevisionInputs
            ? {
                baseRef: baseRef.trim(),
                ...(headRef.trim() ? { headRef: headRef.trim() } : {}),
              }
            : {}),
          ...(selectedFocus ? { focus: selectedFocus } : {}),
          ...(selectedAttachments.length > 0 ? { attachmentIds: selectedAttachments } : {}),
        }
      : null
  const pendingScanMatchesCurrent = Boolean(
    pendingScanSubmission &&
    pendingScanSubmission.principalId === principalId &&
    pendingScanSubmission.workspaceId === workspaceId &&
    pendingScanSubmission.requestIdentity === scanRequestIdentity(createScanRequest)
  )

  useEffect(() => {
    const scopeGeneration = scopeGenerationRef
    ++scopeGeneration.current
    // An older request's finally must not unlock a newer scope's submission.
    scanSubmissionLock.current = { current: false }
    // Browser session storage is external state and is only available after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCreating(false)
    setCheckingScanOperation(false)
    setScanOperationStatus(null)
    setScanRecoveryError(null)
    setScanRecoveryUnavailable(false)
    const scope: ScanSubmissionScope = { principalId, workspaceId, surface: "dashboard" }
    try {
      setPendingScanSubmission(readPendingScanSubmission(scope))
    } catch (cause) {
      setPendingScanSubmission(null)
      setScanRecoveryUnavailable(true)
      setScanRecoveryError(
        cause instanceof Error ? cause.message : "Saved scan recovery data could not be read."
      )
    }
    return () => {
      ++scopeGeneration.current
    }
  }, [principalId, workspaceId])

  useEffect(() => {
    const previous = errorScopeRef.current
    if (previous.principalId === principalId && previous.workspaceId === workspaceId) return
    errorScopeRef.current = { principalId, workspaceId }
    // Keep the server's recovery message on hydration and use the incoming scope's snapshot.
    setError(
      initialRecoveryUnavailable
        ? "This target is no longer available. Choose another target."
        : null
    )
    setErrorCode(null)
  }, [initialRecoveryUnavailable, principalId, workspaceId])

  async function checkPendingScanOperation(submission: PendingScanSubmission) {
    if (!submission.operationId) return
    const scopeGeneration = scopeGenerationRef.current
    const requestId = ++operationRequestRef.current
    const isCurrentOperation = () =>
      scopeGeneration === scopeGenerationRef.current && requestId === operationRequestRef.current
    const operationScope: ScanSubmissionScope = {
      principalId: submission.principalId,
      workspaceId: submission.workspaceId,
      surface: submission.surface,
    }
    setCheckingScanOperation(true)
    setScanRecoveryError(null)
    try {
      const status = await apiGet(
        `/api/agent-operations/${encodeURIComponent(submission.operationId)}?workspaceId=${encodeURIComponent(submission.workspaceId)}`,
        { schema: scanOperationStatusSchema }
      )
      if (status.status === "COMPLETED" && status.resultLocation) {
        const accepted = {
          ...submission,
          state: "accepted" as const,
          scanId: status.resultLocation,
          operationId: status.operationId,
        }
        try {
          recordAcceptedScan(
            operationScope,
            submission.idempotencyKey,
            status.resultLocation,
            status.operationId
          )
        } catch (cause) {
          if (!isCurrentOperation()) return
          setScanRecoveryUnavailable(true)
          setScanRecoveryError(
            cause instanceof Error
              ? cause.message
              : "Scan accepted; recovery details could not be saved."
          )
        }
        if (!isCurrentOperation()) return
        setScanOperationStatus(status)
        setPendingScanSubmission(accepted)
        return
      }
      if (!isCurrentOperation()) return
      setScanOperationStatus(status)
      setScanRecoveryError(
        status.recovery === "retry_new_key"
          ? "The previous attempt was not submitted. Review the request before starting a new attempt."
          : "The previous scan start is still unresolved. Check its status again."
      )
    } catch (cause) {
      if (!isCurrentOperation()) return
      setScanRecoveryError(
        cause instanceof Error ? cause.message : "Could not check the scan status."
      )
    } finally {
      if (isCurrentOperation()) setCheckingScanOperation(false)
    }
  }

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

  // ─── Supporting files: workspace-scoped attachments for this review ────
  // Loaded lazily when the sheet opens; only ACTIVE, workspace-owned artifacts
  // are listed by the API. Selection is inert — ids are validated again
  // server-side at creation and staged read-only by the worker.
  useEffect(() => {
    if (!showCreate) return
    const controller = new AbortController()
    apiGet(`/api/scans/attachments?workspaceId=${encodeURIComponent(workspaceId)}`, {
      schema: scanAttachmentListSchema,
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setAttachments(result.items)
      })
      .catch(() => {
        if (!controller.signal.aborted) setAttachments([])
      })
    return () => controller.abort()
  }, [showCreate, workspaceId])

  function toggleAttachment(id: string) {
    setSelectedAttachments((prev) =>
      prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]
    )
  }

  const eligibilityBlocked = eligibility.status === "ready" && !eligibility.eligibility.allowed
  const startDisabled =
    creating ||
    !selectedTarget ||
    !selectedOption ||
    (selectedOption?.requiresRevisionInputs === true && !baseRef.trim()) ||
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
    const firstAvailable = options.find((o) => o.id === getDefaultScanOptionId(options))
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

  function handleRetryScan(scan: ScanItem) {
    const target = targets.find((item) => item.id === scan.target?.id)
    if (!target) {
      if (scan.target) {
        window.location.assign(
          scanRecoveryHref({ targetId: scan.target.id, goal: scan.goal, mode: scan.mode })
        )
      } else {
        setError("This target is no longer available. Choose another target to run a new scan.")
      }
      return
    }
    const options = getManualScanOptions({
      type: target.type,
      hasApiSpec: Boolean(target.apiSpecUrl),
    })
    const previousPreset = findRecoveryPreset(options, scan.goal, scan.mode)
    setSelectedTarget(target.id)
    choosePreset(previousPreset || getDefaultScanOptionId(options))
    setBaseRef("")
    setHeadRef("")
    setSelectedFocus(null)
    setSelectedAttachments([])
    setError(null)
    setModeResetNotice(
      previousPreset ? null : "The previous review type is unavailable. Choose an available option."
    )
    setShowCreate(true)
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={`Filter by ${TARGET_SINGULAR.toLowerCase()}`}
            value={targetFilter}
            onChange={(e) => handleTargetFilterChange(e.target.value)}
            className="h-11 w-full sm:w-44"
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
            className="h-11 w-full sm:w-40"
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
              New {SCAN_SINGULAR}
            </Button>
          )}
        </div>
      </div>

      {initialFilterUnavailable && !targetFilter && (
        <p role="status" className="text-muted-foreground mb-4 text-sm">
          This target filter is no longer available. Showing all targets with your selected state.
        </p>
      )}
      {pagesReset && (
        <p role="status" aria-live="polite" className="text-muted-foreground mb-4 text-sm">
          Scan updates refreshed the first page. Load more to see older scans.
        </p>
      )}
      <ScanStatusNotices
        showCreate={showCreate}
        error={error}
        errorCode={errorCode}
        eligibilityBlocked={eligibilityBlocked}
        eligibilityCode={eligibility.status === "ready" ? eligibility.eligibility.code : null}
        canManageBilling={canManageBilling}
        scanRecoveryUnavailable={scanRecoveryUnavailable}
        scanRecoveryError={scanRecoveryError}
        scanSubmissionScope={scanSubmissionScope}
        setScanRecoveryUnavailable={setScanRecoveryUnavailable}
        setScanRecoveryError={setScanRecoveryError}
        setForceNewAfterRecovery={setForceNewAfterRecovery}
        setShowCreate={setShowCreate}
        pendingScanSubmission={pendingScanSubmission}
        principalId={principalId}
        workspaceId={workspaceId}
        pendingScanMatchesCurrent={pendingScanMatchesCurrent}
        scanOperationStatus={scanOperationStatus}
        checkingScanOperation={checkingScanOperation}
        checkPendingScanOperation={checkPendingScanOperation}
        setPendingScanSubmission={setPendingScanSubmission}
        setScanOperationStatus={setScanOperationStatus}
        pollStale={pollStale}
        handleRefresh={handleRefresh}
        refreshing={refreshing}
      />

      {/* Composer sheet: right-side on desktop, full-height bottom sheet on mobile. */}
      <CreateScanSheet
        open={showCreate}
        onOpenChange={setShowCreate}
        isDesktop={isDesktop}
        errorCode={errorCode}
        errorMessage={error ? safeApiErrorMessage(error) : null}
        scanRecoveryError={
          scanRecoveryError ??
          (scanRecoveryUnavailable
            ? "Saved scan recovery data could not be read. Starting again may create a second scan."
            : null)
        }
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
        handleCreateScan={() => handleCreateScan(forceNewAfterRecovery)}
        showAdvanced={showAdvanced}
        setShowAdvanced={setShowAdvanced}
        baseRef={baseRef}
        setBaseRef={setBaseRef}
        headRef={headRef}
        setHeadRef={setHeadRef}
        attachments={attachments}
        selectedAttachments={selectedAttachments}
        toggleAttachment={toggleAttachment}
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
        onRetryScan={handleRetryScan}
        cancelling={cancelling}
        removing={removing}
        onCancelScan={handleCancelScan}
        onRemoveScan={handleRemoveScan}
        onLoadMore={handleLoadMore}
      />
    </div>
  )
}
