import { ApiError } from "@/lib/api-client"
import { planIntentPath } from "@/lib/plan-intent"
import type { OperationFailurePresentation } from "@/lib/operation-failure"
import {
  nextStepForPath,
  onboardingPathForTargetType,
  type OnboardingPath,
} from "./onboarding-flow.utils"

/** Structured operation failure surfaced to the wizard's alert area (W1-07). */
export type OnboardingFailureState = {
  presentation: OperationFailurePresentation
  retry: (() => void) | null
} | null

export interface OnboardingData {
  updatedAt?: string
  currentStep: number
  completed: boolean
  skipped: boolean
  workspaceId: string | null
  targetId: string | null
  selectedGoal: string | null
  buildTool?: string | null
  targetType?: string | null
  targetName?: string | null
}

export interface OnboardingWizardProps {
  principalId: string
  initialState: OnboardingData
  selectedPlan?: string | null
  /** Used to name a default workspace when the user has none (W2-01). */
  suggestedWorkspaceName?: string
  /**
   * Whether the sign-up acquisition cookie was still present when the page
   * rendered — the server already claimed it; this only drives client-side
   * cookie cleanup.
   */
  acquisitionCookiePresent?: boolean
  /**
   * Bounded target-type hint carried through signup (e.g. a Lite Check user
   * arrives wanting a URL review). Preselects the chooser path only when the
   * user has not already progressed — never a redirect, never a raw URL.
   */
  targetTypeHint?: "url" | "api" | null
  /**
   * W2-05: server-verified OAuth return state. When present, onboarding
   * completion returns the user to /oauth/consent with the preserved
   * authorization request instead of the dashboard. The destination is a
   * fixed route — the query is the only thing carried — and the signature,
   * expiry, and user binding were verified by the server page.
   */
  oauthReturnState?: string
  oauthReturnQuery?: string | null
}

// Workspace naming is outside the critical path. An arriving target hint
// starts at its details only before the user has progressed or made a target.
export function initialOnboardingSelection(
  initialState: OnboardingData,
  targetTypeHint?: "url" | "api" | null
): { path: OnboardingPath; step: number } {
  const hintedPath: OnboardingPath =
    targetTypeHint && !initialState.targetId && !initialState.targetType ? targetTypeHint : null
  const persistedStep = Math.max(initialState.currentStep ?? 1, 1)
  return {
    path: onboardingPathForTargetType(initialState.targetType ?? null) ?? hintedPath,
    step:
      hintedPath && persistedStep <= 1
        ? (nextStepForPath(hintedPath) ?? persistedStep)
        : persistedStep,
  }
}

// W2-05: where completion lands. An OAuth-arriving user returns to the
// consent screen (their memberships are re-checked there); everyone else
// keeps the existing destinations. The plan intent is dropped on the OAuth
// return path — the consent flow, not billing, is the pending task.
export function onboardingCompletionPath(
  oauthReturnQuery?: string | null,
  selectedPlan?: string | null
): string {
  return oauthReturnQuery
    ? `/oauth/consent?${oauthReturnQuery}`
    : selectedPlan
      ? planIntentPath("/dashboard/billing", selectedPlan)
      : "/dashboard"
}

export function bucketCount(n: number): string {
  if (n <= 0) return "0"
  if (n <= 3) return "1-3"
  if (n <= 10) return "4-10"
  if (n <= 50) return "11-50"
  return "50+"
}

export function bucketDuration(ms: number): string {
  if (ms < 250) return "under_250ms"
  if (ms < 1000) return "250ms_1s"
  if (ms < 3000) return "1s_3s"
  if (ms < 10000) return "3s_10s"
  return "10s_plus"
}

export function friendlyTargetError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === "SSRF_BLOCKED") {
      return "That URL isn't allowed because it points to an internal, private or unresolvable address. Use a public target you own or are authorized to scan."
    }
    if (cause.code === "VALIDATION_ERROR") {
      return "We couldn't save your target. Please check the name and URL and try again."
    }
    // A same-source conflict can differ in target settings, so direct users
    // to review the existing target instead of suggesting automatic reuse.
    if (cause.code === "TARGET_EXISTS") {
      return "A target for this source already exists in your workspace. Open Targets to review it before continuing — no duplicate was created."
    }
  }
  return cause instanceof Error ? cause.message : "Could not start the review."
}
