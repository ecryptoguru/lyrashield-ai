"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { track } from "@/lib/analytics"
import { OnboardingScanRecovery } from "./onboarding-scan-recovery"
import {
  initialOnboardingSelection,
  onboardingCompletionPath,
  type OnboardingFailureState,
  type OnboardingWizardProps,
} from "./onboarding-wizard-model"
import {
  displayStepForPath,
  getOnboardingReviewOptions,
  onboardingStepEyebrow,
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
import { useOnboardingStepActions } from "./use-onboarding-step-actions"
import { useOnboardingEntryEffects } from "./use-onboarding-entry-effects"

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
  useOnboardingEntryEffects({ selectedPlan, acquisitionCookiePresent })
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
    ensureWorkspace,
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
    router,
    connectGitHub,
    ensureWorkspace,
    persist,
    setLoading,
    setError,
    setFailure,
    setPath,
  })
  const { continueWithUrlTarget, confirmRepoAndContinue } = useOnboardingStepActions({
    workspaceId: data.workspaceId,
    path,
    productName,
    urlForm,
    environment,
    selectedRepo,
    ensureWorkspace,
    setError,
    setFailure,
    setPath,
    setProductName,
    setStep,
  })

  // The progress list and the current-step indicator both derive from the step
  // model in onboarding-flow.utils (v16 3.1) — the same definitions the
  // wizard's step transitions use, so the highlight and the "Step N of M"
  // announcement cannot drift from the rendered list. Workspace naming is not
  // a step (W2-01): the server provisions the workspace.
  const steps = stepModelForPath(path, step)
  const displayStep = displayStepForPath(step, path)
  const eyebrow = onboardingStepEyebrow(step, path)
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
        hasFailedScanAttempt={Boolean(error) || failure !== null}
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
