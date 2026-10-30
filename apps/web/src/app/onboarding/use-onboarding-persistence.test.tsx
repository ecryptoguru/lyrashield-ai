import { beforeEach, describe, expect, it, vi } from "vitest"
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), refresh: vi.fn() }))
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, vi.fn()],
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: api.refresh }) }))
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
  updatedAt: "2026-10-30T00:00:00.000Z",
  currentStep: 1,
  completed: false,
  skipped: false,
  workspaceId: null,
  targetId: null,
  selectedGoal: null,
}
describe("onboarding workspace choice", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue([{ id: "ws-oldest" }])
    api.post.mockResolvedValue({
      state: { ...initialState, workspaceId: "ws-selected" },
      workspace: { id: "ws-selected", name: "Selected", role: "DEVELOPER", canManageGitHub: false },
      trialStarted: false,
    })
  })
  it("requires an explicit choice rather than adopting the oldest membership", async () => {
    const persistence = useOnboardingPersistence({ initialState })
    await expect(persistence.ensureWorkspace()).rejects.toThrow("Choose a workspace")
    expect(api.post).not.toHaveBeenCalled()
    expect(api.get).not.toHaveBeenCalled()
  })
  it("saves an explicit selection with one atomic onboarding request", async () => {
    const persistence = useOnboardingPersistence({ initialState })
    await expect(
      persistence.chooseWorkspace({ kind: "select", workspaceId: "ws-selected" })
    ).resolves.toBe("ws-selected")
    expect(api.post).toHaveBeenCalledWith(
      "/api/onboarding/workspace",
      { kind: "select", workspaceId: "ws-selected", expectedUpdatedAt: initialState.updatedAt },
      expect.any(Object)
    )
    expect(api.patch).not.toHaveBeenCalled()
  })
  it("coalesces repeated creates in the same tab and uses the saved state immediately", async () => {
    let release!: (value: unknown) => void
    api.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const persistence = useOnboardingPersistence({ initialState })
    const first = persistence.chooseWorkspace({ kind: "create", name: "Mine" })
    const second = persistence.chooseWorkspace({ kind: "create", name: "Mine" })
    release({
      state: { ...initialState, workspaceId: "ws-selected" },
      workspace: { id: "ws-selected", name: "Mine", role: "OWNER", canManageGitHub: true },
      trialStarted: true,
    })
    await expect(Promise.all([first, second])).resolves.toEqual(["ws-selected", "ws-selected"])
    await expect(persistence.ensureWorkspace()).resolves.toBe("ws-selected")
    expect(api.post).toHaveBeenCalledOnce()
  })
  it("keeps explicit input on changed access and exposes a chooser recovery", async () => {
    api.post.mockRejectedValue(
      new ApiError("WORKSPACE_UNAVAILABLE", "Workspace no longer available", 403)
    )
    const persistence = useOnboardingPersistence({ initialState })
    await expect(
      persistence.chooseWorkspace({ kind: "select", workspaceId: "ws-selected" })
    ).rejects.toThrow("Workspace no longer available")
    expect(api.refresh).not.toHaveBeenCalled()
  })
})

it("carries the displayed missing-target reset on the first explicit save with its optimistic version", async () => {
  const normalized = { ...initialState, workspaceId: "ws-valid" }
  let stored: OnboardingData = { ...normalized, currentStep: 3, targetId: "deleted-target" }
  api.patch.mockImplementation(async (_url: string, body: Partial<OnboardingData>) => {
    stored = { ...stored, ...body }
    return stored
  })
  const persistence = useOnboardingPersistence({ initialState: normalized })
  await expect(persistence.persist({ buildTool: "cursor" })).resolves.toMatchObject({
    workspaceId: "ws-valid",
    targetId: null,
    currentStep: 1,
    buildTool: "cursor",
  })
  expect(api.patch).toHaveBeenCalledWith(
    "/api/onboarding",
    expect.objectContaining({ targetId: null, expectedUpdatedAt: "2026-10-30T00:00:00.000Z" }),
    expect.any(Object)
  )
})

it("does not overwrite a newer target when missing-target recovery conflicts", async () => {
  const normalized = { ...initialState, workspaceId: "ws-valid" }
  const newer = {
    ...normalized,
    targetId: "other-tab-target",
    currentStep: 3,
    updatedAt: "2026-10-30T00:00:00.001Z",
  }
  api.patch.mockImplementation(
    async (_url: string, body: Partial<OnboardingData> & { expectedUpdatedAt?: string }) => {
      if (body.expectedUpdatedAt !== newer.updatedAt)
        throw new ApiError("ONBOARDING_CHANGED", "Setup changed in another tab", 409)
      throw new Error("The stale write must not be applied")
    }
  )
  const persistence = useOnboardingPersistence({ initialState: normalized })
  await expect(persistence.persist({ buildTool: "cursor" })).rejects.toMatchObject({
    code: "ONBOARDING_CHANGED",
  })
  expect(newer).toMatchObject({ targetId: "other-tab-target", currentStep: 3 })
})

it("allows an explicit freshly bound target to override missing-target recovery", async () => {
  const normalized = { ...initialState, workspaceId: "ws-valid" }
  api.patch.mockImplementation(async (_url: string, body: Partial<OnboardingData>) => ({
    ...normalized,
    ...body,
  }))
  const persistence = useOnboardingPersistence({ initialState: normalized })
  await expect(
    persistence.persist({ targetId: "new-target", currentStep: 3 })
  ).resolves.toMatchObject({ targetId: "new-target", currentStep: 3 })
})
