import { beforeEach, describe, expect, it, vi } from "vitest"

const { requirePlatformAdminIdentity, getPlatformAdminOverview, notFound } = vi.hoisted(() => ({
  requirePlatformAdminIdentity: vi.fn(),
  getPlatformAdminOverview: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePlatformAdminIdentity: (...args: unknown[]) => requirePlatformAdminIdentity(...args),
}))
vi.mock("@/lib/platform-admin-overview", () => ({
  getPlatformAdminOverview: (...args: unknown[]) => getPlatformAdminOverview(...args),
}))
vi.mock("next/navigation", () => ({ notFound }))

import PlatformAdminPage from "./page"

describe("platform admin overview page", () => {
  beforeEach(() => vi.clearAllMocks())

  it("never starts privileged reads for an unauthorized request", async () => {
    requirePlatformAdminIdentity.mockRejectedValue(new Error("UNAUTHORIZED"))

    await expect(PlatformAdminPage()).rejects.toThrow("NEXT_NOT_FOUND")
    expect(getPlatformAdminOverview).not.toHaveBeenCalled()
  })
})
