import { z } from "zod"
import { apiGet, apiPost } from "@/lib/api-client"
import { scanEligibilitySchema } from "@/lib/api-schemas"
import type { OnboardingEligibilityState } from "./onboarding-step-views"

type EligibilityView = {
  setCheckedEligibilityKey: (key: string | null) => void
  setScanEligibility: (state: OnboardingEligibilityState) => void
}

export type OnboardingTrialStartState = { confirmed: string | null; unknown: string | null }

export async function readScanEligibility(
  view: EligibilityView,
  workspaceId: string,
  targetId: string,
  scanRequest: { goal: string; mode: string }
): Promise<OnboardingEligibilityState> {
  view.setCheckedEligibilityKey(JSON.stringify([targetId, scanRequest.goal, scanRequest.mode]))
  view.setScanEligibility({ status: "checking" })
  const query = new URLSearchParams({ workspaceId, targetId, ...scanRequest })
  try {
    const eligibility = await apiGet(`/api/scans/eligibility?${query.toString()}`, {
      schema: scanEligibilitySchema,
    })
    const state = { status: "ready", eligibility } as const
    view.setScanEligibility(state)
    return state
  } catch {
    const state = { status: "error" } as const
    view.setScanEligibility(state)
    return state
  }
}

export async function ensureOnboardingTrialStarted({
  view,
  workspaceId,
  targetId,
  scanRequest,
  trialStart,
}: {
  view: EligibilityView
  workspaceId: string
  targetId: string
  scanRequest: { goal: string; mode: string }
  trialStart: { current: OnboardingTrialStartState }
}): Promise<boolean> {
  if (trialStart.current.confirmed === workspaceId) return true

  if (trialStart.current.unknown === workspaceId) {
    const eligibility = await readScanEligibility(view, workspaceId, targetId, scanRequest)
    if (eligibility.status !== "ready") return false
    trialStart.current.unknown = null
    if (eligibility.eligibility.allowed || eligibility.eligibility.code !== "TRIAL_AVAILABLE") {
      return false
    }
  }

  try {
    await apiPost(
      "/api/billing/trial/start",
      { workspaceId },
      { schema: z.object({ started: z.literal(true) }).passthrough() }
    )
    trialStart.current.confirmed = workspaceId
    trialStart.current.unknown = null
    return true
  } catch (cause) {
    trialStart.current.unknown = workspaceId
    throw cause
  }
}
