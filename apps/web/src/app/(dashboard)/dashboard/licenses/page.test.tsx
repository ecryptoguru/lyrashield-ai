import { beforeEach, describe, expect, it, vi } from "vitest"

const { requirePlatformAdminIdentity, licenseFindMany, notFound } = vi.hoisted(() => ({
  requirePlatformAdminIdentity: vi.fn(),
  licenseFindMany: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePlatformAdminIdentity: (...args: unknown[]) => requirePlatformAdminIdentity(...args),
}))
vi.mock("@lyrashield/db", () => ({
  getSystemPrisma: () => ({ license: { findMany: licenseFindMany } }),
}))
vi.mock("next/navigation", () => ({ notFound }))

import LicensesPage from "./page"

describe("platform licenses page", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePlatformAdminIdentity.mockResolvedValue({ userId: "admin-1" })
    licenseFindMany.mockResolvedValue([])
  })

  it("never starts privileged reads for an unauthorized request", async () => {
    requirePlatformAdminIdentity.mockRejectedValue(new Error("FORBIDDEN"))

    await expect(LicensesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    )
    expect(licenseFindMany).not.toHaveBeenCalled()
  })

  it("uses the privileged client only after platform-admin authorization", async () => {
    await LicensesPage({ searchParams: Promise.resolve({}) })

    expect(requirePlatformAdminIdentity).toHaveBeenCalledOnce()
    expect(licenseFindMany).toHaveBeenCalledOnce()
  })
})
