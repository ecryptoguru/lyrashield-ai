import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"
import { apiPost, ApiError } from "@/lib/api-client"
import { track } from "@/lib/analytics"
import { idSchema } from "@/lib/api-schemas"
import { presentOperationFailure } from "@/lib/operation-failure"
import {
  beginScanSubmission,
  clearPendingScanSubmission,
  readPendingScanSubmission,
  recordAcceptedScan,
  runScanSubmission,
  type PendingScanSubmission,
  type ScanOperationStatus,
  type ScanSubmissionScope,
} from "@/lib/scan-submission"
import {
  checkPendingScanOperation,
  deriveOnboardingScanRecovery,
} from "./onboarding-scan-recovery-state"
import { resolveScanSubmissionFailure } from "../(dashboard)/dashboard/scans/scan-submission-failure"
import {
  ensureOnboardingTrialStarted,
  readScanEligibility,
  type OnboardingTrialStartState,
} from "./onboarding-scan-eligibility"
import { TARGET_SINGULAR } from "@/lib/terminology"
import type { ManualScanOption } from "@/lib/scan-presets"
import {
  buildUrlTargetPayload,
  ensureOnboardingTargetId,
  pathNeedsRepo,
  type OnboardingPath,
} from "./onboarding-flow.utils"
import {
  friendlyTargetError,
  type OnboardingData,
  type OnboardingFailureState,
} from "./onboarding-wizard-model"
import type { OnboardingEligibilityState, Repo } from "./onboarding-step-views"
import type { OnboardingPersist } from "./use-onboarding-persistence"

interface ScanFlowContext {
  principalId: string
  data: OnboardingData
  path: OnboardingPath
  selectedRepo: Repo | null
  productName: string
  urlForm: { url: string; ownershipAttested: boolean }
  environment: string
  selectedReview: ManualScanOption | undefined
  completionPath: string
  oauthReturnQuery: string | null | undefined
  router: ReturnType<typeof useRouter>
  persist: OnboardingPersist
  // P1-1: the start action creates the workspace when the URL/API form did not.
  ensureWorkspace: () => Promise<string>
  setLoading: (loading: boolean) => void
  setError: (message: string | null) => void
  setFailure: (failure: OnboardingFailureState) => void
  scanSubmissionLock: { current: boolean }
  startNewScanAfterPreflight: { current: boolean }
  targetRecovery: { current: { identity: string; targetId: string } | null }
  trialStart: { current: OnboardingTrialStartState }
  checkedEligibilityKey: string | null
  setCheckedEligibilityKey: (key: string | null) => void
  scanEligibility: OnboardingEligibilityState
  setScanEligibility: (state: OnboardingEligibilityState) => void
  setPendingScanSubmission: (submission: PendingScanSubmission | null) => void
  setScanOperationStatus: (status: ScanOperationStatus | null) => void
  setCheckingScanOperation: (checking: boolean) => void
  setScanRecoveryError: (message: string | null) => void
  setScanRecoveryUnavailable: (unavailable: boolean) => void
  // W2.3: the wizard computes whether the persisted targetId still describes
  // the visible source; the flow reuses it only when this is true.
  persistedTargetReusable: boolean
  onTargetBound: (needsRepo: boolean) => void
}

function createIdleScanEligibility(): OnboardingEligibilityState {
  return { status: "idle" }
}

/**
 * Structured failure boundary (W1-07): a mappable reason code renders as
 * cause/effect/recovery with a one-click retry; anything else falls back to
 * the plain message. Nothing here auto-retries or creates approvals.
 */
function presentFailure(
  ctx: ScanFlowContext,
  cause: unknown,
  retry: (() => void) | null,
  targetName?: string
) {
  if (cause instanceof ApiError && cause.code) {
    ctx.setError(null)
    ctx.setFailure({ presentation: presentOperationFailure(cause.code, { targetName }), retry })
    return
  }
  ctx.setFailure(null)
  ctx.setError(friendlyTargetError(cause))
}

/**
 * Persist onboarding completion and hand the user off to their started scan.
 * Called only after a scan has been accepted, so the wizard's last durable
 * write is the one that closes the flow.
 */
async function finishAcceptedOnboarding(ctx: ScanFlowContext, scanId: string, goal: string) {
  ctx.setLoading(true)
  ctx.setError(null)
  ctx.setFailure(null)
  ctx.setScanRecoveryError(null)
  try {
    await ctx.persist({ currentStep: 4, completed: true, skipped: false, selectedGoal: goal })
  } catch {
    ctx.setScanRecoveryError("Your scan started; onboarding could not be saved.")
    ctx.setLoading(false)
    return
  }
  if (ctx.selectedReview) {
    track("first_run_started", {
      preset: goal,
      asset_count: 1,
      estimate_low_min: ctx.selectedReview.estimate.low,
      estimate_high_min: ctx.selectedReview.estimate.high,
    })
  }
  // W2-05: agent-first completion returns to the originating client's
  // consent flow; the started scan keeps running server-side.
  ctx.router.push(ctx.oauthReturnQuery ? ctx.completionPath : `/dashboard/scans/${scanId}`)
  ctx.router.refresh()
  ctx.setLoading(false)
}

function existingTargetIdFromError(cause: unknown): string | null {
  if (!(cause instanceof ApiError) || cause.code !== "TARGET_EXISTS") return null
  if (typeof cause.details !== "object" || cause.details === null) return null
  if (!("existingTargetId" in cause.details)) return null
  const parsed = z.string().min(1).safeParse(cause.details.existingTargetId)
  return parsed.success ? parsed.data : null
}

/**
 * Create-or-recover the target the scan request will reference. A retry after
 * scan admission reuses the persisted targetId; a TARGET_EXISTS conflict
 * adopts the already-created target instead of duplicating it.
 */
async function ensureTargetId(
  ctx: ScanFlowContext,
  workspaceId: string,
  needsRepo: boolean,
  reusePersisted: boolean
): Promise<string> {
  const targetIdentity = JSON.stringify([
    workspaceId,
    needsRepo
      ? [
          "REPO",
          ctx.selectedRepo?.owner,
          ctx.selectedRepo?.name,
          ctx.selectedRepo?.defaultBranch,
          ctx.selectedRepo?.installationId,
        ]
      : [ctx.path, ctx.urlForm.url.trim()],
    ctx.productName.trim(),
    ctx.environment,
  ])
  const recoveredTargetId =
    ctx.targetRecovery.current?.identity === targetIdentity
      ? ctx.targetRecovery.current.targetId
      : null
  return ensureOnboardingTargetId(
    (reusePersisted ? ctx.data.targetId : null) ?? recoveredTargetId,
    async () => {
      let targetId: string
      try {
        if (needsRepo && ctx.selectedRepo) {
          const target = await apiPost(
            "/api/targets",
            {
              workspaceId,
              name: ctx.productName.trim(),
              type: "REPO",
              repoProvider: "github",
              repoOwner: ctx.selectedRepo.owner,
              repoName: ctx.selectedRepo.name,
              installationId: ctx.selectedRepo.installationId,
              branch: ctx.selectedRepo.defaultBranch,
              environment: ctx.environment,
            },
            { schema: idSchema }
          )
          targetId = target.id
        } else {
          const target = buildUrlTargetPayload({
            workspaceId,
            path: ctx.path,
            name: ctx.productName,
            url: ctx.urlForm.url,
            environment: ctx.environment,
            ownershipAttested: ctx.urlForm.ownershipAttested,
          })
          if (!target) throw new Error("Target details are required.")
          const created = await apiPost("/api/targets", target, { schema: idSchema })
          targetId = created.id
        }
      } catch (cause) {
        const existingTargetId = existingTargetIdFromError(cause)
        if (!existingTargetId) throw cause
        targetId = existingTargetId
      }
      ctx.targetRecovery.current = { identity: targetIdentity, targetId }
      return targetId
    }
  )
}

/**
 * Read-only advisory preflight — the scan-create endpoint still makes the
 * authoritative decision on the explicit second click. Returns true when the
 * flow must stop so the user can confirm.
 */
async function gateOnEligibility(
  ctx: ScanFlowContext,
  workspaceId: string,
  targetId: string,
  scanRequest: { goal: string; mode: string },
  skipEligibilityCheck: boolean
): Promise<boolean> {
  const eligibilityKey = JSON.stringify([targetId, scanRequest.goal, scanRequest.mode])
  if (
    skipEligibilityCheck ||
    (ctx.checkedEligibilityKey === eligibilityKey &&
      ctx.scanEligibility.status === "ready" &&
      ctx.scanEligibility.eligibility.allowed)
  ) {
    return false
  }
  await readScanEligibility(ctx, workspaceId, targetId, scanRequest)
  return true
}

/**
 * Reconcile pending submission state before POST /api/scans. Returns the
 * submission to continue with, or null when the flow must stop for a user
 * decision (already accepted, or an unresolved previous attempt).
 */
function reconcilePendingSubmission(
  ctx: ScanFlowContext,
  scope: ScanSubmissionScope,
  scanRequest: { workspaceId: string; targetId: string; goal: string; mode: string },
  startNewScan: boolean,
  explicitlyStartingNew: boolean
): PendingScanSubmission | null {
  if (explicitlyStartingNew) {
    const existing = readPendingScanSubmission(scope)
    if (existing?.state === "accepted") {
      ctx.setPendingScanSubmission(existing)
      ctx.setScanRecoveryError("A scan has already started. Open it or retry saving onboarding.")
      return null
    }
    if (existing) clearPendingScanSubmission(scope, existing.idempotencyKey)
  }
  let begun = beginScanSubmission(scope, scanRequest)
  if (begun.kind === "conflict") {
    ctx.setPendingScanSubmission(begun.submission)
    if (!startNewScan || begun.submission.state === "accepted") {
      ctx.setScanRecoveryError(
        "A previous scan may still be starting. Retry its original details or explicitly start a new scan."
      )
      return null
    }
    clearPendingScanSubmission(scope, begun.submission.idempotencyKey)
    begun = beginScanSubmission(scope, scanRequest)
  }
  return begun.submission
}

/**
 * POST /api/scans with the idempotency key carried by the submission. Returns
 * null when the outcome is ambiguous — the recovery surface then guides the
 * user instead of silently retrying.
 */
async function submitScanRequest(
  ctx: ScanFlowContext,
  scope: ScanSubmissionScope,
  scanRequest: { workspaceId: string; targetId: string; goal: string; mode: string },
  submission: PendingScanSubmission
): Promise<{ id: string; operationId?: string } | null> {
  try {
    return await apiPost("/api/scans", scanRequest, {
      schema: idSchema.extend({ operationId: z.string().optional() }).passthrough(),
      headers: { "Idempotency-Key": submission.idempotencyKey },
    })
  } catch (cause) {
    const failure = resolveScanSubmissionFailure({ scope, submission, error: cause })
    ctx.setPendingScanSubmission(failure.pendingSubmission)
    ctx.setScanRecoveryError(failure.recoveryError)
    presentFailure(
      ctx,
      cause,
      () => void runCreateTargetAndStart(ctx),
      ctx.productName.trim() || undefined
    )
    return null
  }
}

async function runCreateTargetAndStart(
  ctx: ScanFlowContext,
  startNewScan = false,
  skipEligibilityCheck = false,
  startTrial = false
) {
  // The workspace is normally created when the URL/API form is submitted, but
  // a user can reach this action without that having happened — a restored
  // session, a stale persisted step or a direct start. Create it here rather
  // than dead-ending on "Workspace is required." (P1-1). The duplicate-submit
  // lock below covers a double tap.
  let workspaceId = ctx.data.workspaceId
  if (!workspaceId) {
    try {
      workspaceId = await ctx.ensureWorkspace()
    } catch (cause) {
      ctx.setError(cause instanceof Error ? cause.message : "Could not prepare your workspace.")
      return
    }
  }
  // A retry after scan admission fails reuses the target persisted by the
  // first attempt — but only while it still describes the source the wizard
  // shows. New flows create it here so Back -> Continue cannot orphan
  // a duplicate before the final action, and an edited URL / different repo
  // / different path must never silently scan the previously stored target.
  const hasExistingTarget = ctx.persistedTargetReusable
  // A selected repo can only come from the repo-select step — treat it as
  // GitHub evidence even when the chooser path was lost across the OAuth
  // install redirect (OnboardingState persists the step, not the path).
  const needsRepo = pathNeedsRepo(ctx.path) || Boolean(ctx.selectedRepo)
  if (!hasExistingTarget && needsRepo && !ctx.selectedRepo) {
    ctx.setError("Workspace and repository are required.")
    return
  }
  if (
    !hasExistingTarget &&
    !needsRepo &&
    !buildUrlTargetPayload({
      workspaceId,
      path: ctx.path,
      name: ctx.productName,
      url: ctx.urlForm.url,
      environment: ctx.environment,
      ownershipAttested: ctx.urlForm.ownershipAttested,
    })
  ) {
    ctx.setError("Add a valid target and confirm ownership to continue.")
    return
  }
  if (!hasExistingTarget && !ctx.productName.trim()) {
    ctx.setError(`Name your ${TARGET_SINGULAR.toLowerCase()} to continue.`)
    return
  }
  if (!ctx.selectedReview) {
    ctx.setError("Choose a goal for this review.")
    return
  }
  const selectedReview = ctx.selectedReview

  await runScanSubmission(ctx.scanSubmissionLock, async () => {
    ctx.setLoading(true)
    ctx.setError(null)
    ctx.setFailure(null)
    ctx.setScanRecoveryError(null)
    if (startNewScan) ctx.startNewScanAfterPreflight.current = true
    try {
      const targetId = await ensureTargetId(ctx, workspaceId, needsRepo, hasExistingTarget)
      ctx.onTargetBound(needsRepo)
      if (ctx.data.targetId !== targetId || ctx.data.selectedGoal !== selectedReview.goal) {
        await ctx.persist({
          targetId,
          selectedGoal: selectedReview.goal,
          currentStep: 3,
          skipped: false,
        })
      }

      const scope: ScanSubmissionScope = {
        principalId: ctx.principalId,
        workspaceId,
        surface: "onboarding",
      }
      const scanRequest = {
        workspaceId,
        targetId,
        goal: selectedReview.goal,
        mode: selectedReview.mode,
      }
      if (await gateOnEligibility(ctx, workspaceId, targetId, scanRequest, skipEligibilityCheck)) {
        return
      }

      if (
        startTrial &&
        !(await ensureOnboardingTrialStarted({
          view: ctx,
          workspaceId,
          targetId,
          scanRequest,
          trialStart: ctx.trialStart,
        }))
      ) {
        return
      }

      const explicitlyStartingNew = startNewScan || ctx.startNewScanAfterPreflight.current
      let submission = reconcilePendingSubmission(
        ctx,
        scope,
        scanRequest,
        startNewScan,
        explicitlyStartingNew
      )
      if (!submission) return
      ctx.setPendingScanSubmission(submission)
      if (submission.state === "accepted" && submission.scanId) {
        await finishAcceptedOnboarding(
          ctx,
          submission.scanId,
          ctx.data.selectedGoal ?? selectedReview.goal
        )
        return
      }
      if (submission.operationId) {
        await checkPendingScanOperation(ctx, submission, workspaceId)
        return
      }

      const scan = await submitScanRequest(ctx, scope, scanRequest, submission)
      if (!scan) return

      ctx.startNewScanAfterPreflight.current = false

      const operationId = typeof scan.operationId === "string" ? scan.operationId : undefined
      submission = {
        ...submission,
        state: "accepted",
        scanId: scan.id,
        ...(operationId ? { operationId } : {}),
      }
      ctx.setPendingScanSubmission(submission)
      try {
        recordAcceptedScan(scope, submission.idempotencyKey, scan.id, operationId)
      } catch (cause) {
        ctx.setScanRecoveryUnavailable(true)
        ctx.setScanRecoveryError(
          cause instanceof Error
            ? cause.message
            : "Scan accepted; recovery details could not be saved."
        )
      }
      await finishAcceptedOnboarding(ctx, scan.id, selectedReview.goal)
    } catch (cause) {
      presentFailure(
        ctx,
        cause,
        () => void runCreateTargetAndStart(ctx),
        ctx.productName.trim() || undefined
      )
    } finally {
      ctx.setLoading(false)
    }
  })
}

/**
 * Owns the scan-start flow: pending-submission recovery state, the advisory
 * eligibility gate, target create-or-recover, and the idempotent POST. The
 * wizard renders the surfaces; every transition here goes through the shared
 * scan-submission ledger in session storage.
 */
export function useOnboardingScan({
  principalId,
  data,
  path,
  selectedRepo,
  productName,
  urlForm,
  environment,
  selectedReview,
  completionPath,
  oauthReturnQuery,
  persist,
  ensureWorkspace,
  setLoading,
  setError,
  setFailure,
  persistedTargetReusable,
  onTargetBound,
}: {
  principalId: string
  data: OnboardingData
  path: OnboardingPath
  selectedRepo: Repo | null
  productName: string
  urlForm: { url: string; ownershipAttested: boolean }
  environment: string
  selectedReview: ManualScanOption | undefined
  completionPath: string
  oauthReturnQuery: string | null | undefined
  persist: OnboardingPersist
  ensureWorkspace: () => Promise<string>
  setLoading: (loading: boolean) => void
  setError: (message: string | null) => void
  setFailure: (failure: OnboardingFailureState) => void
  // W2.3: the wizard computes whether the persisted targetId still describes
  // the visible source; the flow reuses it only when this is true.
  persistedTargetReusable: boolean
  onTargetBound: (needsRepo: boolean) => void
}) {
  const router = useRouter()
  const scanSubmissionLock = useRef(false)
  const [pendingScanSubmission, setPendingScanSubmission] = useState<PendingScanSubmission | null>(
    null
  )
  const [scanOperationStatus, setScanOperationStatus] = useState<ScanOperationStatus | null>(null)
  const [checkingScanOperation, setCheckingScanOperation] = useState(false)
  const [scanRecoveryError, setScanRecoveryError] = useState<string | null>(null)
  const [scanRecoveryUnavailable, setScanRecoveryUnavailable] = useState(false)
  const [scanEligibility, setScanEligibility] = useState(createIdleScanEligibility)
  const [checkedEligibilityKey, setCheckedEligibilityKey] = useState<string | null>(null)
  const startNewScanAfterPreflight = useRef(false)
  const targetRecovery = useRef<{ identity: string; targetId: string } | null>(null)
  const trialStart = useRef<OnboardingTrialStartState>({ confirmed: null, unknown: null })

  const ctx: ScanFlowContext = {
    principalId,
    data,
    path,
    selectedRepo,
    productName,
    urlForm,
    environment,
    selectedReview,
    completionPath,
    oauthReturnQuery,
    router,
    persist,
    ensureWorkspace,
    setLoading,
    setError,
    setFailure,
    scanSubmissionLock,
    startNewScanAfterPreflight,
    targetRecovery,
    trialStart,
    checkedEligibilityKey,
    setCheckedEligibilityKey,
    scanEligibility,
    setScanEligibility,
    setPendingScanSubmission,
    setScanOperationStatus,
    setCheckingScanOperation,
    setScanRecoveryError,
    setScanRecoveryUnavailable,
    persistedTargetReusable,
    onTargetBound,
  }

  useEffect(() => {
    // Browser session storage is external state and is only available after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScanOperationStatus(null)
    setScanRecoveryUnavailable(false)
    setScanRecoveryError(null)
    const workspaceId = data.workspaceId
    if (!workspaceId) {
      setPendingScanSubmission(null)
      return
    }
    try {
      const pending = readPendingScanSubmission({
        principalId,
        workspaceId,
        surface: "onboarding",
      })
      setPendingScanSubmission(pending)
    } catch (cause) {
      setPendingScanSubmission(null)
      setScanRecoveryUnavailable(true)
      setScanRecoveryError(
        cause instanceof Error ? cause.message : "Saved scan recovery data could not be read."
      )
    }
  }, [principalId, data.workspaceId])

  const { pendingScanMatchesCurrent, visibleEligibility } = deriveOnboardingScanRecovery({
    principalId,
    data,
    selectedReview,
    pendingScanSubmission,
    checkedEligibilityKey,
    scanEligibility,
  })

  const createTargetAndStart = (
    startNewScan = false,
    skipEligibilityCheck = false,
    startTrial = false
  ) => runCreateTargetAndStart(ctx, startNewScan, skipEligibilityCheck, startTrial)

  const onStartAnotherAfterUnavailable = () => {
    if (!data.workspaceId) return
    try {
      clearPendingScanSubmission({
        principalId,
        workspaceId: data.workspaceId,
        surface: "onboarding",
      })
      setScanRecoveryUnavailable(false)
      setScanRecoveryError(null)
      void createTargetAndStart(true)
    } catch (cause) {
      setScanRecoveryError(
        cause instanceof Error ? cause.message : "Could not clear scan recovery data."
      )
    }
  }
  const onRetrySave = (scanId: string, goal: string) =>
    void runScanSubmission(scanSubmissionLock, () => finishAcceptedOnboarding(ctx, scanId, goal))
  const onCheckPending = (submission: PendingScanSubmission) =>
    void checkPendingScanOperation(ctx, submission)
  const onRetrySame = () => void createTargetAndStart()
  const onStartNew = () => void createTargetAndStart(true)

  return {
    pendingScanSubmission,
    pendingScanMatchesCurrent,
    scanOperationStatus,
    checkingScanOperation,
    scanRecoveryError,
    scanRecoveryUnavailable,
    visibleEligibility,
    createTargetAndStart,
    onStartAnotherAfterUnavailable,
    onRetrySave,
    onCheckPending,
    onRetrySame,
    onStartNew,
  }
}
