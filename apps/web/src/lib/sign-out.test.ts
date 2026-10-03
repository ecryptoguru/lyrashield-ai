import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  invalidateAnalyticsPreference: vi.fn(),
  clearFindingsListSessionStorage: vi.fn(),
}))

vi.mock("@lyrashield/auth", () => ({ authClient: { signOut: mocks.signOut } }))
vi.mock("@/lib/analytics", () => ({
  invalidateAnalyticsPreference: mocks.invalidateAnalyticsPreference,
}))
vi.mock("@/lib/findings-list-session-storage", () => ({
  clearFindingsListSessionStorage: mocks.clearFindingsListSessionStorage,
}))

import { signOutAndClearSessionData } from "./sign-out"

describe("signOutAndClearSessionData", () => {
  beforeEach(() => {
    mocks.signOut.mockReset()
    mocks.invalidateAnalyticsPreference.mockReset()
    mocks.clearFindingsListSessionStorage.mockReset()
  })

  it("clears account-scoped browser state after successful sign-out", async () => {
    mocks.signOut.mockResolvedValue({ error: null })

    await expect(signOutAndClearSessionData()).resolves.toEqual({ error: null })

    expect(mocks.invalidateAnalyticsPreference).toHaveBeenCalledOnce()
    expect(mocks.clearFindingsListSessionStorage).toHaveBeenCalledOnce()
  })

  it("retains browser state when sign-out fails", async () => {
    const error = { message: "sign-out failed" }
    mocks.signOut.mockResolvedValue({ error })

    await expect(signOutAndClearSessionData()).resolves.toEqual({ error })

    expect(mocks.invalidateAnalyticsPreference).not.toHaveBeenCalled()
    expect(mocks.clearFindingsListSessionStorage).not.toHaveBeenCalled()
  })
})
