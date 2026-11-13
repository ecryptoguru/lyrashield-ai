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

function licenseRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `license-${index}`,
    ownerEmail: "owner@example.test",
    sku: "LOCAL",
    seatCount: 1,
    activations: [],
    machineIds: [],
    updateEligibleUntil: new Date("2027-01-01T00:00:00Z"),
    perpetualFallbackBuild: null,
    revoked: false,
    revokedAt: null,
    revocations: [],
    issuedAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    key: null,
  }))
}

describe("bounded license continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePlatformAdminIdentity.mockResolvedValue({ userId: "admin-1" })
  })
  it("reads one extra row, renders only 100, and continues after the last rendered identity", async () => {
    licenseFindMany.mockResolvedValue(licenseRows(101))
    const element = await LicensesPage({
      searchParams: Promise.resolve({
        q: " owner@example.test ",
        status: "revoked",
        cursor: "license-before",
      }),
    })
    expect(licenseFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        take: 101,
        cursor: { id: "license-before" },
        skip: 1,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        where: {
          revoked: true,
          ownerEmail: { contains: "owner@example.test", mode: "insensitive" },
        },
      })
    )
    const client = element.props.children[1]
    expect(client.props.initialData).toHaveLength(100)
    expect(client.props.nextCursor).toBe("license-99")
    expect(client.props.cursor).toBe("license-before")
  })

  it("has no continuation at the exact page boundary and ignores malformed cursor/filter values", async () => {
    licenseFindMany.mockResolvedValue(licenseRows(100))
    const element = await LicensesPage({
      searchParams: Promise.resolve({ status: "invalid", cursor: "../invalid" }),
    })
    const args = licenseFindMany.mock.calls.at(-1)![0]
    expect(args).not.toHaveProperty("cursor")
    expect(args.where.revoked).toBe(false)
    expect(element.props.children[1].props.nextCursor).toBeNull()
  })
})
