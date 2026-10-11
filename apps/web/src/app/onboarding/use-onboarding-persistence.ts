import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api-client"
import { track } from "@/lib/analytics"
import { onboardingDataSchema } from "@/lib/api-schemas"
import type { OnboardingData } from "./onboarding-wizard-model"

export type OnboardingPersist = (updates: Partial<OnboardingData>) => Promise<OnboardingData>

/**
 * Owns the durable onboarding record: local `data` state, the
 * optimistic-concurrency anchor (`persistedState`), and lazy workspace
 * creation. Step views never write onboarding state directly — every update
 * goes through `persist`, which applies the server's response as the single
 * source of truth.
 */
export function useOnboardingPersistence({
  initialState,
  step,
  suggestedWorkspaceName,
}: {
  initialState: OnboardingData
  step: number
  suggestedWorkspaceName?: string
}) {
  const router = useRouter()
  const [data, setData] = useState(initialState)
  const persistedState = useRef(initialState)

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

  /**
   * W2-01: workspace creation is lazy and unnamed. The workspace is created
   * with a sensible default only when the user picks a path that needs one —
   * never merely by visiting onboarding, and never with a required naming
   * step. A concurrent tab that won the slug race is adopted instead of
   * duplicated.
   */
  async function ensureWorkspace(): Promise<string> {
    if (data.workspaceId) return data.workspaceId

    const existing = await apiGet("/api/workspaces", {
      schema: z.array(z.object({ id: z.string().min(1) })),
    })
    const adoptWorkspace = async (workspaceId: string) => {
      await persist({ workspaceId, currentStep: Math.max(step, 1), skipped: false })
      return workspaceId
    }
    const available = existing[0]
    if (available) return adoptWorkspace(available.id)

    let workspace: { id: string; trialStarted?: boolean }
    try {
      workspace = await apiPost(
        "/api/workspaces",
        { name: suggestedWorkspaceName?.trim() || "My workspace", mode: "VIBE" },
        { schema: z.object({ id: z.string(), trialStarted: z.boolean().optional() }) }
      )
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "SLUG_TAKEN") {
        // A concurrent tab created the default workspace first: adopt it.
        const existing = await apiGet("/api/workspaces", {
          schema: z.array(z.object({ id: z.string().min(1) })),
        })
        const adopted = existing[0]
        if (!adopted) throw cause
        return adoptWorkspace(adopted.id)
      }
      throw cause
    }

    // The trial grant lands inside the workspace-creation transaction —
    // only fire when the account actually claimed it (never on re-use).
    if (workspace.trialStarted) track("trial_started", { surface: "onboarding" })
    return adoptWorkspace(workspace.id)
  }

  return { data, persist, ensureWorkspace }
}
