import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  $executeRaw: vi.fn(),
  onboardingState: { findUnique: vi.fn() },
}

vi.mock("@lyrashield/db", () => ({ prisma }))

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
})
