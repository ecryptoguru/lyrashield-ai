import { beforeEach, describe, expect, it, vi } from "vitest"

const getSession = vi.fn()
const getWorkspaceMembership = vi.fn()
const getOrCreateOnboardingState = vi.fn()
const prisma = {
  target: { findFirst: vi.fn() },
  onboardingState: { update: vi.fn() },
}

vi.mock("@lyrashield/auth/server", () => ({ getSession, getWorkspaceMembership }))
vi.mock("@lyrashield/db", () => ({ prisma }))
vi.mock("@/lib/onboarding-state", () => ({ getOrCreateOnboardingState }))

const { GET, PATCH } = await import("./route")

function patchRequest(body: unknown) {
  return new Request("http://localhost:3000/api/onboarding", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("GET /api/onboarding", () => {
  it("returns 401 when the caller is unauthenticated", async () => {
    getSession.mockResolvedValue(null)
    const response = await GET()
    expect(response.status).toBe(401)
  })

  it("returns the current onboarding state", async () => {
    getSession.mockResolvedValue({ userId: "user-1" })
    getOrCreateOnboardingState.mockResolvedValue({
      id: "onboarding-1",
      currentStep: 1,
      completed: false,
      skipped: false,
      workspaceId: null,
      targetId: null,
      selectedGoal: null,
    })

    const response = await GET()
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.id).toBe("onboarding-1")
  })
})

describe("PATCH /api/onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ userId: "user-1" })
    getWorkspaceMembership.mockResolvedValue({ role: "OWNER" })
    getOrCreateOnboardingState.mockResolvedValue({
      id: "onboarding-1",
      currentStep: 1,
      completed: false,
      skipped: false,
      workspaceId: "ws-1",
      targetId: null,
      selectedGoal: null,
    })
    prisma.onboardingState.update.mockResolvedValue({
      id: "onboarding-1",
      currentStep: 2,
      completed: false,
      skipped: false,
      workspaceId: "ws-1",
      targetId: "target-1",
      selectedGoal: "LAUNCH_REVIEW",
    })
  })

  it("rejects an unauthenticated request", async () => {
    getSession.mockResolvedValue(null)
    const response = await PATCH(patchRequest({ skipped: true }))
    expect(response.status).toBe(401)
  })

  it("rejects invalid JSON", async () => {
    const response = await PATCH(
      new Request("http://localhost:3000/api/onboarding", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not-json",
      })
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "INVALID_JSON" },
    })
  })

  it("rejects an attacker-controlled workspaceId the user does not belong to", async () => {
    getWorkspaceMembership.mockResolvedValueOnce(null)

    const response = await PATCH(patchRequest({ workspaceId: "ws-attacker" }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "FORBIDDEN" },
    })
    expect(prisma.onboardingState.update).not.toHaveBeenCalled()
  })

  it("rejects a targetId when the user has not selected a workspace", async () => {
    getOrCreateOnboardingState.mockResolvedValue({
      id: "onboarding-1",
      currentStep: 1,
      completed: false,
      skipped: false,
      workspaceId: null,
      targetId: null,
      selectedGoal: null,
    })

    const response = await PATCH(patchRequest({ targetId: "target-1" }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR" },
    })
  })

  it("rejects a targetId that does not belong to the caller's workspace", async () => {
    prisma.target.findFirst.mockResolvedValue(null)

    const response = await PATCH(patchRequest({ targetId: "target-attacker" }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "FORBIDDEN" },
    })
  })

  it("updates the onboarding state when workspace and target pass ownership checks", async () => {
    prisma.target.findFirst.mockResolvedValue({ workspaceId: "ws-1" })

    const response = await PATCH(
      patchRequest({
        workspaceId: "ws-1",
        targetId: "target-1",
        selectedGoal: "LAUNCH_REVIEW",
      })
    )

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.success).toBe(true)
    expect(json.data.workspaceId).toBe("ws-1")
    expect(json.data.targetId).toBe("target-1")
  })
})
