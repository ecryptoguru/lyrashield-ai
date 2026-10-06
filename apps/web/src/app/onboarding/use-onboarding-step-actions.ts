import { track } from "@/lib/analytics"
import {
  buildUrlTargetPayload,
  nextStepForPath,
  type OnboardingPath,
} from "./onboarding-flow.utils"
import type { OnboardingFailureState } from "./onboarding-wizard-model"
import type { Repo } from "./onboarding-step-views"

/**
 * Owns the transitions from URL/API target entry and repository selection to
 * target details. Target creation remains deferred to the scan action.
 */
export function useOnboardingStepActions({
  workspaceId,
  path,
  productName,
  urlForm,
  environment,
  selectedRepo,
  setError,
  setFailure,
  setPath,
  setProductName,
  setStep,
}: {
  workspaceId: string | null
  path: OnboardingPath
  productName: string
  urlForm: { url: string; ownershipAttested: boolean }
  environment: string
  selectedRepo: Repo | null
  setError: (message: string | null) => void
  setFailure: (failure: OnboardingFailureState) => void
  setPath: (path: OnboardingPath) => void
  setProductName: (name: string) => void
  setStep: (step: number) => void
}) {
  function continueWithUrlTarget() {
    const payload = buildUrlTargetPayload({
      workspaceId,
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

  function confirmRepoAndContinue() {
    if (!selectedRepo) {
      setError("Select a repository to continue.")
      return
    }
    // OnboardingState persists currentStep but not the selected path. After
    // OAuth returns at step 2, bind the GitHub path before target creation.
    if (!path) setPath("github")
    track("repos_selected", { selected_count: 1 })
    setProductName(selectedRepo.name)
    setStep(3)
  }

  return { continueWithUrlTarget, confirmRepoAndContinue }
}
