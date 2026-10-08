import { useRef } from "react"
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
 *
 * The workspace is created here too. The URL/API forms are the first step a
 * user reaches and a hinted Lite Check user arrives on them directly, so this
 * is the last point before the details step where a workspace can be created
 * without asking (P1-1).
 */
export function useOnboardingStepActions({
  workspaceId,
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
}: {
  workspaceId: string | null
  path: OnboardingPath
  productName: string
  urlForm: { url: string; ownershipAttested: boolean }
  environment: string
  selectedRepo: Repo | null
  ensureWorkspace: () => Promise<string>
  setError: (message: string | null) => void
  setFailure: (failure: OnboardingFailureState) => void
  setPath: (path: OnboardingPath) => void
  setProductName: (name: string) => void
  setStep: (step: number) => void
}) {
  // Duplicate-submit protection: a double tap must not create a second
  // workspace or advance twice. A ref, not a closure variable, because
  // `ensureWorkspace` re-renders the wizard and would otherwise hand the second
  // tap a fresh closure with the flag already reset (P1-1).
  const submitting = useRef(false)

  async function continueWithUrlTarget() {
    if (submitting.current) return
    // The visible input is validated before the workspace call, so an
    // incomplete form reports its own problem and never creates a workspace
    // the user did not get past the first step for. Message selection keeps the
    // original precedence: an unattested form always asks for attestation.
    if (path !== "url" && path !== "api") return
    const missingSource = !productName.trim() || !urlForm.url.trim()
    if (missingSource || !urlForm.ownershipAttested) {
      setError(
        urlForm.ownershipAttested
          ? "Enter a name and a valid URL to continue."
          : "Confirm you own or are authorized to scan this target."
      )
      return
    }
    submitting.current = true
    setError(null)
    setFailure(null)
    let resolvedWorkspaceId = workspaceId
    if (!resolvedWorkspaceId) {
      try {
        resolvedWorkspaceId = await ensureWorkspace()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not prepare your workspace.")
        submitting.current = false
        return
      }
    }
    const payload = buildUrlTargetPayload({
      workspaceId: resolvedWorkspaceId,
      path,
      name: productName,
      url: urlForm.url,
      environment,
      ownershipAttested: urlForm.ownershipAttested,
    })
    if (!payload) {
      setError("Enter a name and a valid URL to continue.")
      submitting.current = false
      return
    }
    const next = nextStepForPath(payload.type === "API" ? "api" : "url")
    if (next !== null) setStep(next)
    submitting.current = false
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
