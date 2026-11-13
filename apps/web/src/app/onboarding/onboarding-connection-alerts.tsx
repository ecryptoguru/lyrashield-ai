import { GitHubConnectionRecovery } from "@/components/github-connection-recovery"
import { OnboardingAlerts } from "./onboarding-step-views"
import type { OnboardingFailureState } from "./onboarding-wizard-model"

export function OnboardingConnectionAlerts({
  failure,
  error,
  loading,
  setFailure,
  githubStatus,
  canManageGitHub,
  onConnect,
  onSkip,
}: {
  failure: OnboardingFailureState
  error: string | null
  loading: boolean
  setFailure: (failure: OnboardingFailureState) => void
  githubStatus?: string
  canManageGitHub?: boolean
  onConnect: (mode?: "existing" | "install-new") => void
  onSkip: () => void
}) {
  return (
    <>
      <GitHubConnectionRecovery
        status={githubStatus}
        busy={loading}
        onConnect={canManageGitHub ? onConnect : undefined}
        onSkip={onSkip}
      />
      <OnboardingAlerts
        failure={failure}
        error={error}
        loading={loading}
        onRetryFailure={(retry) => {
          setFailure(null)
          retry()
        }}
      />
    </>
  )
}
