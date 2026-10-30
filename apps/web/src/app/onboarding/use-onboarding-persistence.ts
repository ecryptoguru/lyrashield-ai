import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"
import { apiPatch, apiPost, ApiError } from "@/lib/api-client"
import { track } from "@/lib/analytics"
import { onboardingDataSchema } from "@/lib/api-schemas"
import type { OnboardingWorkspaceChoice } from "@/lib/onboarding-workspace-schema"
import type { OnboardingData } from "./onboarding-wizard-model"

export type OnboardingPersist = (updates: Partial<OnboardingData>) => Promise<OnboardingData>
const workspaceResultSchema = z.object({
  state: onboardingDataSchema,
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    canManageGitHub: z.boolean(),
  }),
  trialStarted: z.boolean(),
})

/** Durable state and one atomic user-scoped workspace choice, including cross-tab retries. */
export function useOnboardingPersistence({
  initialState,
  canManageGitHub = false,
}: {
  initialState: OnboardingData
  canManageGitHub?: boolean
}) {
  const router = useRouter()
  const [data, setData] = useState(initialState)
  const [workspaceCanManageGitHub, setWorkspaceCanManageGitHub] = useState(canManageGitHub)
  const persistedState = useRef(initialState)
  const workspaceRequest = useRef<Promise<string> | null>(null)

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

  function chooseWorkspace(choice: OnboardingWorkspaceChoice): Promise<string> {
    if (workspaceRequest.current) return workspaceRequest.current
    const request = (async () => {
      try {
        const result = await apiPost(
          "/api/onboarding/workspace",
          { ...choice, expectedUpdatedAt: persistedState.current.updatedAt },
          { schema: workspaceResultSchema }
        )
        persistedState.current = result.state
        setData(result.state)
        setWorkspaceCanManageGitHub(result.workspace.canManageGitHub)
        if (result.trialStarted) track("trial_started", { surface: "onboarding" })
        return result.workspace.id
      } finally {
        workspaceRequest.current = null
      }
    })()
    workspaceRequest.current = request
    return request
  }

  async function ensureWorkspace(): Promise<string> {
    if (persistedState.current.workspaceId) return persistedState.current.workspaceId
    if (workspaceRequest.current) return workspaceRequest.current
    throw new Error("Choose a workspace or create one before continuing.")
  }
  return { data, persist, ensureWorkspace, chooseWorkspace, workspaceCanManageGitHub }
}
