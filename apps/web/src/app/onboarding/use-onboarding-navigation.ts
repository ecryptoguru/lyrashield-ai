import { track } from "@/lib/analytics"
import type { OnboardingPath } from "./onboarding-flow.utils"
import type { OnboardingData, OnboardingFailureState } from "./onboarding-wizard-model"
import type { OnboardingPersist } from "./use-onboarding-persistence"

/**
 * Path choice and skip flows for the onboarding wizard. The workspace is
 * created lazily on the URL/API paths (W2-01) — no naming step; the default
 * name is editable later in settings.
 */
export function useOnboardingNavigation(params: {
  data: OnboardingData
  completionPath: string
  productName: string
  router: { push: (path: string) => void; refresh: () => void }
  connectGitHub: () => Promise<unknown> | void
  ensureWorkspace: () => Promise<unknown>
  persist: OnboardingPersist
  setLoading: (loading: boolean) => void
  setError: (message: string | null) => void
  setFailure: (failure: OnboardingFailureState) => void
  setPath: (path: OnboardingPath) => void
  setProductName: (name: string) => void
}) {
  async function skipOnboarding() {
    params.setLoading(true)
    params.setError(null)
    params.setFailure(null)
    try {
      await params.persist({ skipped: true, currentStep: 0 })
      params.router.push(params.completionPath)
      params.router.refresh()
    } catch (cause) {
      params.setError(cause instanceof Error ? cause.message : "Could not skip setup.")
      params.setLoading(false)
    }
  }

  async function choosePath(next: Exclude<OnboardingPath, null>) {
    params.setError(null)
    params.setFailure(null)
    track("onboarding_path_chosen", { path: next })
    if (next === "skip") {
      void skipOnboarding()
      return
    }
    if (next === "github") {
      void params.connectGitHub()
      return
    }
    // URL / API: the workspace is created lazily here (W2-01) — no naming
    // step; the default name is editable later in settings.
    if (!params.data.workspaceId) {
      params.setLoading(true)
      try {
        await params.ensureWorkspace()
      } catch (cause) {
        params.setError(cause instanceof Error ? cause.message : "Could not prepare your workspace.")
        return
      } finally {
        params.setLoading(false)
      }
    }
    // URL / API: prefill a sensible target name, then collect the URL. The
    // onward step comes from the shared step model so the wizard and the flow
    // logic cannot diverge.
    params.setPath(next)
    if (!params.productName) {
      params.setProductName(next === "api" ? "Production API" : "Staging Site")
    }
  }

  return { choosePath, skipOnboarding }
}
