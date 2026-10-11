import { beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }))

vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, vi.fn()],
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }))
vi.mock("@/lib/api-client", () => ({
  apiGet: api.get,
  apiPatch: api.patch,
  apiPost: api.post,
  ApiError: class ApiError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number
    ) {
      super(message)
    }
  },
}))

import { ApiError } from "@/lib/api-client"
import type { OnboardingData } from "./onboarding-wizard-model"
import { useOnboardingPersistence } from "./use-onboarding-persistence"

const initialState: OnboardingData = {
  currentStep: 1,
  completed: false,
  skipped: false,
  workspaceId: null,
  targetId: null,
  selectedGoal: null,
}

describe("useOnboardingPersistence workspace adoption", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.patch.mockImplementation(async (_url: string, updates: Partial<OnboardingData>) => ({
      ...initialState,
      ...updates,
    }))
    api.post.mockResolvedValue({ id: "ws-created", trialStarted: false })
  })

  it("adopts the first available membership before creating a workspace", async () => {
    api.get.mockResolvedValue([{ id: "ws-oldest" }, { id: "ws-newer" }])
    const persistence = useOnboardingPersistence({ initialState, step: 1 })

    await expect(persistence.ensureWorkspace()).resolves.toBe("ws-oldest")

    expect(api.get).toHaveBeenCalledOnce()
    expect(api.post).not.toHaveBeenCalled()
    expect(api.patch).toHaveBeenCalledWith(
      "/api/onboarding",
      expect.objectContaining({ workspaceId: "ws-oldest", skipped: false }),
      expect.any(Object)
    )
  })

  it("allows an empty workspace list and creates a workspace", async () => {
    api.get.mockResolvedValue([])
    const persistence = useOnboardingPersistence({ initialState, step: 1 })

    await expect(persistence.ensureWorkspace()).resolves.toBe("ws-created")

    expect(api.get).toHaveBeenCalledOnce()
    expect(api.post).toHaveBeenCalledOnce()
    expect(api.get.mock.invocationCallOrder[0]).toBeLessThan(api.post.mock.invocationCallOrder[0]!)
  })

  it("rereads an empty-list race without requiring a non-empty response", async () => {
    api.get.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "ws-race" }])
    api.post.mockRejectedValueOnce(new ApiError("SLUG_TAKEN", "Workspace slug already exists", 409))
    const persistence = useOnboardingPersistence({ initialState, step: 1 })

    await expect(persistence.ensureWorkspace()).resolves.toBe("ws-race")

    expect(api.get).toHaveBeenCalledTimes(2)
    expect(api.patch).toHaveBeenCalledWith(
      "/api/onboarding",
      expect.objectContaining({ workspaceId: "ws-race" }),
      expect.any(Object)
    )
  })
})
