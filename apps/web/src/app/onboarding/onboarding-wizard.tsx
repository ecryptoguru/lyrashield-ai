"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { ACQUISITION_COOKIE, track } from "@/lib/analytics"
import { rememberPlanIntent } from "@/lib/plan-intent"
import { OnboardingScanRecovery } from "./onboarding-scan-recovery"
import {
  initialOnboardingSelection,
  onboardingCompletionPath,
  type OnboardingFailureState,
  type OnboardingWizardProps,
} from "./onboarding-wizard-model"
import {
  buildUrlTargetPayload,
  displayStepForPath,
  getOnboardingReviewOptions,
  nextStepForPath,
  pathNeedsRepo,
  stepModelForPath,
  targetNameFromUrl,
  type OnboardingPath,
} from "./onboarding-flow.utils"
import { OnboardingAlerts, OnboardingStepSection, StepProgress } from "./onboarding-step-views"
import { useOnboardingPersistence } from "./use-onboarding-persistence"
import { useOnboardingRepos } from "./use-onboarding-repos"
import { useOnboardingScan } from "./use-onboarding-scan"
import { useOnboardingTargetBinding } from "./use-onboarding-target-binding"
import { useOnboardingNavigation } from "./use-onboarding-navigation"

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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Structured operation failure (cause/effect/recovery + retry) — preferred
  // over the plain string when the server returned a mappable reason code.
  const [failure, setFailure] = useState<OnboardingFailureState>(null)

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
  const [urlForm, setUrlForm] = useState({ url: "", ownershipAttested: false })
  const [buildTool, setBuildTool] = useState<string | null>(initialState.buildTool ?? null)

  const { data, persist, ensureWorkspace } = useOnboardingPersistence({
    initialState,
    step,
    suggestedWorkspaceName,
  })
  const {
    repos,
    reposLoaded,
    selectedRepo,
    setSelectedRepo,
    githubUnavailable,
    loadRepos,
    connectGitHub,
  } = useOnboardingRepos({
    workspaceId: data.workspaceId,
    step,
    setPath,
    setLoading,
    setError,
    setFailure,
    ensureWorkspace,
    persist,
    oauthReturnState,
  })
  const reviewOptions = getOnboardingReviewOptions(path)
  const selectedReview =
    reviewOptions.find((option) => option.goal === selectedGoal) ?? reviewOptions[0]
  const { persistedTargetReusable, onTargetBound, onRepoSelected, onUrlEdited } =
    useOnboardingTargetBinding({
      data,
      path,
      initialStateTargetType: initialState.targetType ?? null,
      selectedRepo,
      setSelectedRepo,
    })

  const {
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
  } = useOnboardingScan({
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
    setLoading,
    setError,
    setFailure,
    persistedTargetReusable,
    onTargetBound,
  })

  const retryingExistingTarget = persistedTargetReusable

  const { choosePath, skipOnboarding } = useOnboardingNavigation({
    data,
    completionPath,
    productName,
    router,
    connectGitHub,
    ensureWorkspace,
    persist,
    setLoading,
    setError,
    setFailure,
    setPath,
    setProductName,
  })

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
    // W2.3: the repo-select step is only reachable through the GitHub path,
    // but OnboardingState persists only currentStep — after the OAuth install
    // redirect the wizard restores with path null and step 2. Re-binding the
    // path here keeps review options (REPO) and target creation (repository
    // payload) from falling into the URL/API branch and blocking the first
    // scan with "Add a valid target".
    if (!path) setPath("github")
    track("repos_selected", { selected_count: 1 })
    setProductName(selectedRepo.name)
    setStep(3)
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
  const busy = loading || pendingScanSubmission?.state === "accepted"

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
        onStartAnotherAfterUnavailable={onStartAnotherAfterUnavailable}
        onRetrySave={onRetrySave}
        onCheckPending={onCheckPending}
        onRetrySame={onRetrySame}
        onStartNew={onStartNew}
      />

      <OnboardingStepSection
        step={step}
        path={path}
        eyebrow={eyebrow}
        busy={busy}
        loading={loading}
        buildTool={buildTool}
        onBuildTool={(next) => {
          setBuildTool(next)
          if (next) track("onboarding_context", { tool: next })
          persist({ buildTool: next }).catch(() => {})
        }}
        githubUnavailable={githubUnavailable}
        onChoosePath={choosePath}
        urlForm={urlForm}
        productName={productName}
        onProductNameChange={setProductName}
        onUrlChange={(url) => {
          setUrlForm({ ...urlForm, url })
          onUrlEdited()
          // W2-02: selection and naming are one step — the name prefills
          // from the parsed host and stays editable.
          if (!productName || productName === "Staging Site" || productName === "Production API") {
            const fromHost = targetNameFromUrl(url)
            if (fromHost) setProductName(fromHost)
          }
        }}
        onOwnershipChange={(attested) => setUrlForm({ ...urlForm, ownershipAttested: attested })}
        onUrlBack={() => setPath(null)}
        onUrlSubmit={continueWithUrlTarget}
        repos={repos}
        reposLoaded={reposLoaded}
        selectedRepoId={selectedRepo?.id ?? null}
        onSelectRepo={onRepoSelected}
        reposLoadFailed={Boolean(error)}
        onLoadRepos={loadRepos}
        onReconnect={connectGitHub}
        onRepoBack={() => setStep(1)}
        onRepoContinue={confirmRepoAndContinue}
        retryingExistingTarget={retryingExistingTarget}
        reviewOptions={reviewOptions}
        selectedReview={selectedReview}
        eligibility={visibleEligibility}
        targetId={data.targetId}
        onSelectGoal={setSelectedGoal}
        onDetailsBack={() => setStep(pathNeedsRepo(path) ? 2 : 1)}
        onStart={(skipEligibilityCheck) => void createTargetAndStart(false, skipEligibilityCheck)}
        onStartTrial={() => void createTargetAndStart(false, true, true)}
        onSkip={() => void skipOnboarding()}
      />
    </div>
  )
}
