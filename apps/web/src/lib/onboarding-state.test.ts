import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  $executeRaw: vi.fn(),
  onboardingState: { findUnique: vi.fn() },
}
const deliver = vi.hoisted(() => vi.fn())

vi.mock("@lyrashield/db", () => ({ prisma }))
vi.mock("./onboarding-workspace-audit", () => ({ deliverOnboardingWorkspaceAudit: deliver }))

const { getOrCreateOnboardingState } = await import("./onboarding-state")

describe("getOrCreateOnboardingState", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$executeRaw.mockResolvedValue(1)
  })

  it("reads the winning row once after the conflict-safe insert", async () => {
    const state = { userId: "user-1", currentStep: 0 }
    prisma.onboardingState.findUnique.mockResolvedValue(state)

    await expect(getOrCreateOnboardingState("user-1")).resolves.toBe(state)

    expect(prisma.$executeRaw).toHaveBeenCalledOnce()
    expect(prisma.onboardingState.findUnique).toHaveBeenCalledOnce()
    expect(prisma.onboardingState.findUnique).toHaveBeenCalledWith({ where: { userId: "user-1" } })
  })

  it("fails promptly if no row is visible after the insert", async () => {
    prisma.onboardingState.findUnique.mockResolvedValue(null)

    await expect(getOrCreateOnboardingState("user-2")).rejects.toThrow(
      "Onboarding state not found for user user-2"
    )

    expect(prisma.onboardingState.findUnique).toHaveBeenCalledOnce()
  })

  it("repairs the retained creation audit on onboarding access", async () => {
    const state = {
      userId: "user-1",
      workspaceId: "selected-workspace",
      pendingWorkspaceCreatedAuditId: "original-workspace",
    }
    prisma.onboardingState.findUnique.mockResolvedValue(state)
    await expect(getOrCreateOnboardingState("user-1")).resolves.toEqual({
      ...state,
      pendingWorkspaceCreatedAuditId: null,
    })
    expect(deliver).toHaveBeenCalledExactlyOnceWith("user-1", "original-workspace")
  })
})
