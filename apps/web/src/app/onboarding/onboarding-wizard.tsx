"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@lyrashield/ui"
import {
  githubReposSchema,
  idSchema,
  installUrlSchema,
  onboardingDataSchema,
  scanEligibilitySchema,
} from "@/lib/api-schemas"
import { z } from "zod"
import { apiGet, apiPost, apiPatch, ApiError } from "@/lib/api-client"
import { ACQUISITION_COOKIE, track } from "@/lib/analytics"
import { presentOperationFailure, type OperationFailurePresentation } from "@/lib/operation-failure"
import { rememberPlanIntent } from "@/lib/plan-intent"
import {
  beginScanSubmission,
  clearPendingScanSubmission,
  operationIdFromErrorDetails,
  readPendingScanSubmission,
  recordAcceptedScan,
  recordScanOperation,
  runScanSubmission,
  scanOperationStatusSchema,
  scanRequestIdentity,
  type PendingScanSubmission,
  type ScanOperationStatus,
  type ScanSubmissionScope,
} from "@/lib/scan-submission"
import { TARGET_SINGULAR } from "@/lib/terminology"
import { OnboardingScanRecovery } from "./onboarding-scan-recovery"
import {
  bucketCount,
  bucketDuration,
  friendlyTargetError,
  initialOnboardingSelection,
  onboardingCompletionPath,
  type OnboardingData,
  type OnboardingWizardProps,
} from "./onboarding-wizard-model"
import {
  buildUrlTargetPayload,
  displayStepForPath,
  ensureOnboardingTargetId,
  getOnboardingReviewOptions,
  nextStepForPath,
  pathNeedsRepo,
  stepModelForPath,
  targetNameFromUrl,
  type OnboardingPath,
} from "./onboarding-flow.utils"
import {
  OnboardingAlerts,
  PathChooserView,
  RepoSelectView,
  StepProgress,
  TargetDetailsView,
  UrlTargetView,
  type OnboardingEligibilityState,
  type Repo,
} from "./onboarding-step-views"

function existingTargetIdFromError(cause: unknown): string | null {
  if (!(cause instanceof ApiError) || cause.code !== "TARGET_EXISTS") return null
  if (typeof cause.details !== "object" || cause.details === null) return null
  if (!("existingTargetId" in cause.details)) return null
  const parsed = z.string().min(1).safeParse(cause.details.existingTargetId)
  return parsed.success ? parsed.data : null
}

export function OnboardingWizard({
  principalId,
  initialState,
  selectedPlan,
  suggestedWorkspaceName,
  oauthReturnQuery,
  oauthReturnState,
  acquisitionCookiePresent,
  targetTypeHint,
}: OnboardingWizardProps) {
  const router = useRouter()
  useEffect(() => {
    rememberPlanIntent(selectedPlan)
    // The acquisition snapshot is already in durable account state server-side;
    // the cookie has done its job.
    if (acquisitionCookiePresent) {
      document.cookie = `${ACQUISITION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
    }
  }, [selectedPlan, acquisitionCookiePresent])
  const completionPath = onboardingCompletionPath(oauthReturnQuery, selectedPlan)
  const initialSelection = initialOnboardingSelection(initialState, targetTypeHint)
  const [step, setStep] = useState(initialSelection.step)
  const [data, setData] = useState(initialState)
  const persistedState = useRef(initialState)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scanSubmissionLock = useRef(false)
  const [pendingScanSubmission, setPendingScanSubmission] = useState<PendingScanSubmission | null>(
    null
  )
  const [scanOperationStatus, setScanOperationStatus] = useState<ScanOperationStatus | null>(null)
  const [checkingScanOperation, setCheckingScanOperation] = useState(false)
  const [scanRecoveryError, setScanRecoveryError] = useState<string | null>(null)
  const [scanRecoveryUnavailable, setScanRecoveryUnavailable] = useState(false)
  const [scanEligibility, setScanEligibility] = useState<OnboardingEligibilityState>({
    status: "idle",
  })
  const [checkedEligibilityKey, setCheckedEligibilityKey] = useState<string | null>(null)
  const startNewScanAfterPreflight = useRef(false)
  // Structured operation failure (cause/effect/recovery + retry) — preferred
  // over the plain string when the server returned a mappable reason code.
  const [failure, setFailure] = useState<{
    presentation: OperationFailurePresentation
    retry: (() => void) | null
  } | null>(null)

  const [repos, setRepos] = useState<Repo[]>([])
  const [reposLoaded, setReposLoaded] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null)
  const [productName, setProductName] = useState(initialState.targetName ?? "")
  // W2-03: environment classification left the critical path. The safe default
  // is metadata on the target and stays editable in target settings; it never
  // changes scanner eligibility, authorization, or execution here.
  const environment = "STAGING"
  const [selectedGoal, setSelectedGoal] = useState<string>(
    initialState.selectedGoal ?? "LAUNCH_REVIEW"
  )
  // Four-way step 2: which way the user chose to add their first target.
  // If the user already created a target (targetId is set) but we don't know
  // which path they took, leave path null — the step is already past step 2.
  const [path, setPath] = useState<OnboardingPath>(initialSelection.path)
  const [githubUnavailable, setGithubUnavailable] = useState(false)
  const [urlForm, setUrlForm] = useState({ url: "", ownershipAttested: false })
  const [buildTool, setBuildTool] = useState<string | null>(initialState.buildTool ?? null)
  const autoFetchAttempted = useRef(false)
  const repoRequest = useRef("")
  const targetRecovery = useRef<{ identity: string; targetId: string } | null>(null)
  const reviewOptions = getOnboardingReviewOptions(path)
  const selectedReview =
    reviewOptions.find((option) => option.goal === selectedGoal) ?? reviewOptions[0]
  const selectedEligibilityKey =
    data.targetId && selectedReview
      ? JSON.stringify([data.targetId, selectedReview.goal, selectedReview.mode])
      : null
  const visibleEligibility =
    checkedEligibilityKey === selectedEligibilityKey ? scanEligibility : { status: "idle" as const }
  const retryingExistingTarget = Boolean(data.targetId)
  const scanSubmissionScope: ScanSubmissionScope | null = data.workspaceId
    ? { principalId, workspaceId: data.workspaceId, surface: "onboarding" }
    : null
  const currentScanRequest =
    scanSubmissionScope && data.targetId && selectedReview
      ? {
          workspaceId: data.workspaceId,
          targetId: data.targetId,
          goal: selectedReview.goal,
          mode: selectedReview.mode,
        }
      : null
  const pendingScanMatchesCurrent = Boolean(
    pendingScanSubmission &&
    pendingScanSubmission.principalId === principalId &&
    pendingScanSubmission.workspaceId === data.workspaceId &&
    currentScanRequest &&
    pendingScanSubmission.requestIdentity === scanRequestIdentity(currentScanRequest)
  )

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

  async function checkPendingScanOperation(submission: PendingScanSubmission) {
    if (!submission.operationId || !data.workspaceId) return
    const scope = { principalId, workspaceId: data.workspaceId, surface: "onboarding" as const }
    setCheckingScanOperation(true)
    setScanRecoveryError(null)
    try {
      const status = await apiGet(
        `/api/agent-operations/${encodeURIComponent(submission.operationId)}?workspaceId=${encodeURIComponent(data.workspaceId)}`,
        { schema: scanOperationStatusSchema }
      )
      setScanOperationStatus(status)
      if (status.status === "COMPLETED" && status.resultLocation) {
        const accepted = {
          ...submission,
          state: "accepted" as const,
          scanId: status.resultLocation,
          operationId: status.operationId,
        }
        setPendingScanSubmission(accepted)
        try {
          recordAcceptedScan(
            scope,
            submission.idempotencyKey,
            status.resultLocation,
            status.operationId
          )
        } catch (cause) {
          setScanRecoveryUnavailable(true)
          setScanRecoveryError(
            cause instanceof Error
              ? cause.message
              : "Scan accepted; recovery details could not be saved."
          )
        }
      } else if (status.recovery === "retry_new_key") {
        setScanRecoveryError("The previous attempt was not submitted. You can start a new attempt.")
      } else {
        setScanRecoveryError("The previous scan start is still unresolved. Check its status again.")
      }
    } catch (cause) {
      setScanRecoveryError(
        cause instanceof Error ? cause.message : "Could not check the scan status."
      )
    } finally {
      setCheckingScanOperation(false)
    }
  }

  async function finishAcceptedOnboarding(scanId: string, goal: string) {
    setLoading(true)
    setError(null)
    setFailure(null)
    setScanRecoveryError(null)
    try {
      await persist({ currentStep: 4, completed: true, skipped: false, selectedGoal: goal })
    } catch {
      setScanRecoveryError("Your scan started; onboarding could not be saved.")
      setLoading(false)
      return
    }
    if (selectedReview) {
      track("first_run_started", {
        preset: goal,
        asset_count: 1,
        estimate_low_min: selectedReview.estimate.low,
        estimate_high_min: selectedReview.estimate.high,
      })
    }
    // W2-05: agent-first completion returns to the originating client's
    // consent flow; the started scan keeps running server-side.
    router.push(oauthReturnQuery ? completionPath : `/dashboard/scans/${scanId}`)
    router.refresh()
    setLoading(false)
  }

  /**
   * Structured failure boundary (W1-07): a mappable reason code renders as
   * cause/effect/recovery with a one-click retry; anything else falls back to
   * the plain message. Nothing here auto-retries or creates approvals.
   */
  function presentFailure(cause: unknown, retry: (() => void) | null, targetName?: string) {
    if (cause instanceof ApiError && cause.code) {
      setError(null)
      setFailure({ presentation: presentOperationFailure(cause.code, { targetName }), retry })
      return
    }
    setFailure(null)
    setError(friendlyTargetError(cause))
  }

  const fetchRepos = useCallback(() => {
    if (!data.workspaceId) return Promise.resolve<Repo[]>([])
    return apiGet<Repo[]>(`/api/integrations/github/repos?workspaceId=${data.workspaceId}`, {
      schema: githubReposSchema,
    })
  }, [data.workspaceId])

  const loadRepos = useCallback(async () => {
    if (!data.workspaceId) return
    setLoading(true)
    setError(null)
    setFailure(null)
    const startedAt = performance.now()
    const requestId = crypto.randomUUID()
    repoRequest.current = requestId
    try {
      const res = await fetchRepos()
      if (requestId !== repoRequest.current) return
      setRepos(res)
      setReposLoaded(true)
      setSelectedRepo((current) => res.find((repo) => repo.id === current?.id) ?? null)
      track("repos_loaded", {
        repo_count_bucket: bucketCount(res.length),
        load_ms_bucket: bucketDuration(performance.now() - startedAt),
      })
    } catch (cause) {
      if (requestId === repoRequest.current) {
        setError(cause instanceof Error ? cause.message : "Could not load repositories.")
      }
    } finally {
      if (requestId === repoRequest.current) setLoading(false)
    }
  }, [data.workspaceId, fetchRepos])

  useEffect(() => {
    if (step !== 2 || autoFetchAttempted.current || !data.workspaceId) return
    autoFetchAttempted.current = true
    const requestId = crypto.randomUUID()
    repoRequest.current = requestId
    const startedAt = performance.now()
    fetchRepos()
      .then((res) => {
        if (requestId !== repoRequest.current) return
        setRepos(res)
        setReposLoaded(true)
        track("repos_loaded", {
          repo_count_bucket: bucketCount(res.length),
          load_ms_bucket: bucketDuration(performance.now() - startedAt),
        })
      })
      .catch((cause) => {
        if (requestId !== repoRequest.current) return
        setError(cause instanceof Error ? cause.message : "Could not load repositories.")
      })
    return () => {
      repoRequest.current = ""
      autoFetchAttempted.current = false
    }
  }, [step, data.workspaceId, fetchRepos])

  async function persist(updates: Partial<OnboardingData>) {
    let next
    try {
      next = await apiPatch(
        "/api/onboarding",
        { ...updates, expectedUpdatedAt: persistedState.current.updatedAt },
        { schema: onboardingDataSchema }
      )
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "ONBOARDING_CHANGED") router.refresh()
      throw cause
    }
    persistedState.current = next
    setData(next)
    return next
  }

  /**
   * W2-01: workspace creation is lazy and unnamed. The workspace is created
   * with a sensible default only when the user picks a path that needs one —
   * never merely by visiting onboarding, and never with a required naming
   * step. A concurrent tab that won the slug race is adopted instead of
   * duplicated.
   */
  async function ensureWorkspace(): Promise<string> {
    if (data.workspaceId) return data.workspaceId
    try {
      const workspace = await apiPost(
        "/api/workspaces",
        { name: suggestedWorkspaceName?.trim() || "My workspace", mode: "VIBE" },
        { schema: z.object({ id: z.string(), trialStarted: z.boolean().optional() }) }
      )
      // The trial grant lands inside the workspace-creation transaction —
      // only fire when the account actually claimed it (never on re-use).
      if (workspace.trialStarted) track("trial_started", { surface: "onboarding" })
      await persist({ workspaceId: workspace.id, currentStep: Math.max(step, 1), skipped: false })
      return workspace.id
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "SLUG_TAKEN") {
        // A concurrent tab created the default workspace first: adopt it.
        const existing = await apiGet("/api/workspaces", {
          schema: z.object({ data: z.array(z.object({ id: z.string().min(1) })).min(1) }),
        })
        const adopted = existing.data[0]
        if (!adopted) throw cause
        await persist({
          workspaceId: adopted.id,
          currentStep: Math.max(step, 1),
          skipped: false,
        })
        return adopted.id
      }
      throw cause
    }
  }

  async function connectGitHub() {
    setLoading(true)
    setError(null)
    setFailure(null)
    try {
      const workspaceId = await ensureWorkspace()
      const res = await apiPost(
        "/api/integrations/github/install",
        {
          workspaceId,
          returnTo: "onboarding",
          ...(oauthReturnState ? { oauthReturnState } : {}),
        },
        { schema: installUrlSchema }
      )
      await persist({ currentStep: 2, skipped: false })
      track("github_connect_started")
      window.location.assign(res.installUrl)
    } catch {
      // The GitHub App is not configured (or the endpoint otherwise failed). Do
      // not strand the user: mark the path unavailable and keep them on the
      // four-way choice with the other three ways forward intact. Only reset the
      // path when the user is still on the chooser — a failed *reconnect* from
      // the repo-select step should not yank them back. Do not interpolate the
      // raw server error into the UI.
      setGithubUnavailable(true)
      if (step === 1) setPath(null)
      setError(
        "GitHub connect is unavailable right now. You can add an app URL or API instead or skip for now."
      )
    } finally {
      setLoading(false)
    }
  }

  async function choosePath(next: Exclude<OnboardingPath, null>) {
    setError(null)
    setFailure(null)
    track("onboarding_path_chosen", { path: next })
    if (next === "skip") {
      void skipOnboarding()
      return
    }
    if (next === "github") {
      void connectGitHub()
      return
    }
    // URL / API: the workspace is created lazily here (W2-01) — no naming
    // step; the default name is editable later in settings.
    if (!data.workspaceId) {
      setLoading(true)
      try {
        await ensureWorkspace()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not prepare your workspace.")
        return
      } finally {
        setLoading(false)
      }
    }
    // URL / API: prefill a sensible target name, then collect the URL. The
    // onward step comes from the shared step model so the wizard and the flow
    // logic cannot diverge.
    setPath(next)
    if (!productName) {
      setProductName(next === "api" ? "Production API" : "Staging Site")
    }
  }

  async function skipOnboarding() {
    setLoading(true)
    setError(null)
    setFailure(null)
    try {
      await persist({ skipped: true, currentStep: 0 })
      router.push(completionPath)
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not skip setup.")
      setLoading(false)
    }
  }

  // Validate the URL/API inputs and advance to target details. The target is
  // NOT created here — creation is deferred to createTargetAndStart (the same
  // step the GitHub path uses) so the name/environment the user confirmed on
  // the first screen are what actually get saved, and so going Back ->
  // Continue never orphans a duplicate target.
  function continueWithUrlTarget() {
    const payload = buildUrlTargetPayload({
      workspaceId: data.workspaceId,
      path,
      name: productName,
      url: urlForm.url,
      environment,
      ownershipAttested: urlForm.ownershipAttested,
    })
    if (!payload) {
      setError(
        urlForm.ownershipAttested
          ? "Enter a name and a valid URL to continue."
          : "Confirm you own or are authorized to scan this target."
      )
      return
    }
    setError(null)
    setFailure(null)
    const next = nextStepForPath(payload.type === "API" ? "api" : "url")
    if (next !== null) setStep(next)
  }

  async function confirmRepoAndContinue() {
    if (!selectedRepo) {
      setError("Select a repository to continue.")
      return
    }
    track("repos_selected", { selected_count: 1 })
    setProductName(selectedRepo.name)
    setStep(3)
  }

  async function createTargetAndStart(
    startNewScan = false,
    skipEligibilityCheck = false,
    startTrial = false
  ) {
    if (!data.workspaceId) {
      setError("Workspace is required.")
      return
    }
    const workspaceId = data.workspaceId
    // A retry after scan admission fails reuses the target persisted by the
    // first attempt. New flows create it here so Back -> Continue cannot orphan
    // a duplicate before the final action.
    const hasExistingTarget = Boolean(data.targetId)
    const needsRepo = pathNeedsRepo(path)
    if (!hasExistingTarget && needsRepo && !selectedRepo) {
      setError("Workspace and repository are required.")
      return
    }
    if (
      !hasExistingTarget &&
      !needsRepo &&
      !buildUrlTargetPayload({
        workspaceId: data.workspaceId,
        path,
        name: productName,
        url: urlForm.url,
        environment,
        ownershipAttested: urlForm.ownershipAttested,
      })
    ) {
      setError("Add a valid target and confirm ownership to continue.")
      return
    }
    if (!hasExistingTarget && !productName.trim()) {
      setError(`Name your ${TARGET_SINGULAR.toLowerCase()} to continue.`)
      return
    }
    if (!selectedReview) {
      setError("Choose a goal for this review.")
      return
    }

    await runScanSubmission(scanSubmissionLock, async () => {
      setLoading(true)
      setError(null)
      setFailure(null)
      setScanRecoveryError(null)
      if (startNewScan) startNewScanAfterPreflight.current = true
      try {
        const targetIdentity = JSON.stringify([
          workspaceId,
          needsRepo
            ? [
                "REPO",
                selectedRepo?.owner,
                selectedRepo?.name,
                selectedRepo?.defaultBranch,
                selectedRepo?.installationId,
              ]
            : [path, urlForm.url.trim()],
          productName.trim(),
          environment,
        ])
        const recoveredTargetId =
          targetRecovery.current?.identity === targetIdentity
            ? targetRecovery.current.targetId
            : null
        const targetId = await ensureOnboardingTargetId(
          data.targetId ?? recoveredTargetId,
          async () => {
            let targetId: string
            try {
              if (needsRepo && selectedRepo) {
                const target = await apiPost(
                  "/api/targets",
                  {
                    workspaceId: data.workspaceId,
                    name: productName.trim(),
                    type: "REPO",
                    repoProvider: "github",
                    repoOwner: selectedRepo.owner,
                    repoName: selectedRepo.name,
                    installationId: selectedRepo.installationId,
                    branch: selectedRepo.defaultBranch,
                    environment,
                  },
                  { schema: idSchema }
                )
                targetId = target.id
              } else {
                const target = buildUrlTargetPayload({
                  workspaceId: data.workspaceId,
                  path,
                  name: productName,
                  url: urlForm.url,
                  environment,
                  ownershipAttested: urlForm.ownershipAttested,
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
            targetRecovery.current = { identity: targetIdentity, targetId }
            return targetId
          }
        )
        if (data.targetId !== targetId || data.selectedGoal !== selectedReview.goal) {
          await persist({
            targetId,
            selectedGoal: selectedReview.goal,
            currentStep: 3,
            skipped: false,
          })
        }

        const scope: ScanSubmissionScope = {
          principalId,
          workspaceId,
          surface: "onboarding",
        }
        const scanRequest = {
          workspaceId,
          targetId,
          goal: selectedReview.goal,
          mode: selectedReview.mode,
        }
        const eligibilityKey = JSON.stringify([targetId, scanRequest.goal, scanRequest.mode])
        if (
          !skipEligibilityCheck &&
          (checkedEligibilityKey !== eligibilityKey ||
            scanEligibility.status !== "ready" ||
            !scanEligibility.eligibility.allowed)
        ) {
          // Read-only advisory preflight; the scan-create endpoint still makes
          // the authoritative decision on the explicit second click.
          setCheckedEligibilityKey(eligibilityKey)
          setScanEligibility({ status: "checking" })
          const query = new URLSearchParams({
            workspaceId,
            targetId,
            goal: scanRequest.goal,
            mode: scanRequest.mode,
          })
          try {
            const eligibility = await apiGet(`/api/scans/eligibility?${query.toString()}`, {
              schema: scanEligibilitySchema,
            })
            setScanEligibility({ status: "ready", eligibility })
          } catch {
            setScanEligibility({ status: "error" })
          }
          return
        }

        if (startTrial) {
          await apiPost("/api/billing/trial/start", { workspaceId })
        }

        const explicitlyStartingNew = startNewScan || startNewScanAfterPreflight.current
        if (explicitlyStartingNew) {
          const existing = readPendingScanSubmission(scope)
          if (existing?.state === "accepted") {
            setPendingScanSubmission(existing)
            setScanRecoveryError("A scan has already started. Open it or retry saving onboarding.")
            return
          }
          if (existing) clearPendingScanSubmission(scope, existing.idempotencyKey)
        }
        let begun = beginScanSubmission(scope, scanRequest)
        if (begun.kind === "conflict") {
          setPendingScanSubmission(begun.submission)
          if (!startNewScan || begun.submission.state === "accepted") {
            setScanRecoveryError(
              "A previous scan may still be starting. Retry its original details or explicitly start a new scan."
            )
            return
          }
          clearPendingScanSubmission(scope, begun.submission.idempotencyKey)
          begun = beginScanSubmission(scope, scanRequest)
        }

        let submission = begun.submission
        setPendingScanSubmission(submission)
        if (submission.state === "accepted" && submission.scanId) {
          await finishAcceptedOnboarding(
            submission.scanId,
            data.selectedGoal ?? selectedReview.goal
          )
          return
        }
        if (submission.operationId) {
          await checkPendingScanOperation(submission)
          return
        }

        let scan: { id: string; operationId?: string }
        try {
          scan = await apiPost("/api/scans", scanRequest, {
            schema: idSchema.extend({ operationId: z.string().optional() }).passthrough(),
            headers: { "Idempotency-Key": submission.idempotencyKey },
          })
        } catch (cause) {
          const operationId =
            cause instanceof ApiError ? operationIdFromErrorDetails(cause.details) : null
          if (operationId) {
            const updated = recordScanOperation(scope, submission.idempotencyKey, operationId)
            submission = updated ?? { ...submission, operationId }
            setPendingScanSubmission(submission)
          }
          setScanRecoveryError(
            cause instanceof Error
              ? cause.message
              : "We could not confirm whether the scan started. Retry with the same details."
          )
          presentFailure(cause, () => void createTargetAndStart(), productName.trim() || undefined)
          return
        }

        startNewScanAfterPreflight.current = false

        const operationId = typeof scan.operationId === "string" ? scan.operationId : undefined
        submission = {
          ...submission,
          state: "accepted",
          scanId: scan.id,
          ...(operationId ? { operationId } : {}),
        }
        setPendingScanSubmission(submission)
        try {
          recordAcceptedScan(scope, begun.submission.idempotencyKey, scan.id, operationId)
        } catch (cause) {
          setScanRecoveryUnavailable(true)
          setScanRecoveryError(
            cause instanceof Error
              ? cause.message
              : "Scan accepted; recovery details could not be saved."
          )
        }
        await finishAcceptedOnboarding(scan.id, selectedReview.goal)
      } catch (cause) {
        presentFailure(cause, () => void createTargetAndStart(), productName.trim() || undefined)
      } finally {
        setLoading(false)
      }
    })
  }

  // The progress list and the current-step indicator both derive from the step
  // model in onboarding-flow.utils (v16 3.1) — the same definitions the
  // wizard's step transitions use, so the highlight and the "Step N of M"
  // announcement cannot drift from the rendered list. Workspace naming is not
  // a step (W2-01): the server provisions the workspace.
  const steps = stepModelForPath(path)
  const displayStep = displayStepForPath(step, path)
  const eyebrow = `Step ${step} of ${steps.length} · ${
    steps[Math.min(displayStep, steps.length - 1)]!.label
  }`

  return (
    <div className="w-full max-w-2xl">
      <StepProgress steps={steps} displayStep={displayStep} />
      <OnboardingAlerts
        failure={failure}
        error={error}
        loading={loading}
        onRetryFailure={(retry) => {
          setFailure(null)
          retry()
        }}
      />

      <OnboardingScanRecovery
        unavailable={scanRecoveryUnavailable}
        recoveryError={scanRecoveryError}
        workspaceId={data.workspaceId}
        principalId={principalId}
        pendingScanSubmission={pendingScanSubmission}
        pendingScanMatchesCurrent={pendingScanMatchesCurrent}
        scanOperationStatus={scanOperationStatus}
        completed={data.completed}
        selectedGoal={data.selectedGoal}
        selectedReviewGoal={selectedReview?.goal}
        loading={loading}
        checkingScanOperation={checkingScanOperation}
        onStartAnotherAfterUnavailable={() => {
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
        }}
        onRetrySave={(scanId, goal) =>
          void runScanSubmission(scanSubmissionLock, () => finishAcceptedOnboarding(scanId, goal))
        }
        onCheckPending={(submission) => void checkPendingScanOperation(submission)}
        onRetrySame={() => void createTargetAndStart()}
        onStartNew={() => void createTargetAndStart(true)}
      />

      <section className="rounded-xl border p-5 sm:p-7" aria-live="polite">
        {step === 1 && path !== "url" && path !== "api" && (
          <PathChooserView
            eyebrow={eyebrow}
            buildTool={buildTool}
            onBuildTool={(next) => {
              setBuildTool(next)
              if (next) track("onboarding_context", { tool: next })
              persist({ buildTool: next }).catch(() => {})
            }}
            loading={loading || pendingScanSubmission?.state === "accepted"}
            githubUnavailable={githubUnavailable}
            onChoosePath={choosePath}
          />
        )}

        {step === 1 && (path === "url" || path === "api") && (
          <UrlTargetView
            eyebrow={eyebrow}
            path={path}
            productName={productName}
            onProductNameChange={setProductName}
            url={urlForm.url}
            ownershipAttested={urlForm.ownershipAttested}
            onUrlChange={(url) => {
              setUrlForm({ ...urlForm, url })
              // W2-02: selection and naming are one step — the name prefills
              // from the parsed host and stays editable.
              if (
                !productName ||
                productName === "Staging Site" ||
                productName === "Production API"
              ) {
                const fromHost = targetNameFromUrl(url)
                if (fromHost) setProductName(fromHost)
              }
            }}
            onOwnershipChange={(attested) =>
              setUrlForm({ ...urlForm, ownershipAttested: attested })
            }
            loading={loading}
            onBack={() => setPath(null)}
            onSubmit={continueWithUrlTarget}
          />
        )}

        {step === 2 && (
          <RepoSelectView
            eyebrow={eyebrow}
            repos={repos}
            reposLoaded={reposLoaded}
            selectedRepoId={selectedRepo?.id ?? null}
            onSelectRepo={setSelectedRepo}
            loading={loading}
            loadFailed={Boolean(error)}
            onLoadRepos={loadRepos}
            onReconnect={connectGitHub}
            onBack={() => setStep(1)}
            onContinue={confirmRepoAndContinue}
          />
        )}

        {step === 3 && (
          <TargetDetailsView
            eyebrow={eyebrow}
            path={path}
            productName={productName}
            onProductNameChange={setProductName}
            retryingExistingTarget={retryingExistingTarget}
            reviewOptions={reviewOptions}
            selectedReview={selectedReview}
            eligibility={visibleEligibility}
            targetId={data.targetId}
            onSelectGoal={setSelectedGoal}
            loading={loading || pendingScanSubmission?.state === "accepted"}
            onBack={() => setStep(pathNeedsRepo(path) ? 2 : 1)}
            onStart={(skipEligibilityCheck) =>
              void createTargetAndStart(false, skipEligibilityCheck)
            }
            onStartTrial={() => void createTargetAndStart(false, true, true)}
          />
        )}

        <div className="mt-6 flex justify-center border-t pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void skipOnboarding()}
            disabled={loading}
          >
            Skip / finish later
          </Button>
        </div>
      </section>
    </div>
  )
}
