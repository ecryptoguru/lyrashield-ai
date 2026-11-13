import { useState } from "react"
import type { OnboardingPath } from "./onboarding-flow.utils"
import type { OnboardingData } from "./onboarding-wizard-model"
import type { Repo } from "./onboarding-step-views"

/**
 * W2.3: a persisted targetId may only be reused while it still describes the
 * source the wizard shows. Editing the URL / picking a different repo marks
 * the binding stale, and switching the chooser path invalidates it via the
 * target-type check below. `boundTargetType` keeps the created target's type
 * within the session — the onboarding PATCH response drops targetType, so
 * without the ref a mid-session path switch could reuse a wrong-type target.
 */
export function useOnboardingTargetBinding(params: {
  data: OnboardingData
  path: OnboardingPath
  initialStateTargetType: string | null
  selectedRepo: Repo | null
  setSelectedRepo: (repo: Repo | null) => void
}) {
  const [targetSourceEdited, setTargetSourceEdited] = useState(false)
  const [boundTargetType, setBoundTargetType] = useState<string | null>(
    params.initialStateTargetType ?? null
  )
  const expectedTargetType =
    params.path === "github"
      ? "REPO"
      : params.path === "url"
        ? "WEB_APP"
        : params.path === "api"
          ? "API"
          : null
  const persistedTargetReusable =
    Boolean(params.data.targetId) &&
    !targetSourceEdited &&
    (expectedTargetType === null ||
      boundTargetType === null ||
      boundTargetType === expectedTargetType)

  function onTargetBound(needsRepo: boolean) {
    // The bound target now provably matches the visible source.
    setBoundTargetType(expectedTargetType ?? (needsRepo ? "REPO" : "WEB_APP"))
    setTargetSourceEdited(false)
  }

  function onRepoSelected(repo: Repo | null) {
    // A different repo after a target exists makes the persisted targetId
    // stale — create the matching target, never scan the old one (W2.3).
    if (params.data.targetId && repo && repo.id !== params.selectedRepo?.id) {
      setTargetSourceEdited(true)
    }
    params.setSelectedRepo(repo)
  }

  function onUrlEdited() {
    // Editing the URL after a target exists must not scan the stale target —
    // the changed source gets its own target row (W2.3).
    if (params.data.targetId) setTargetSourceEdited(true)
  }

  return { persistedTargetReusable, onTargetBound, onRepoSelected, onUrlEdited }
}
