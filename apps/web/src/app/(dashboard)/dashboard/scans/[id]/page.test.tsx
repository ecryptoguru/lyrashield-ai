import { beforeEach, describe, expect, it, vi } from "vitest"

const { getCachedSession, getCachedWorkspaceId, getScanWithEvents, notFound, prisma } = vi.hoisted(
  () => ({
    getCachedSession: vi.fn(),
    getCachedWorkspaceId: vi.fn(),
    getScanWithEvents: vi.fn(),
    notFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND")
    }),
    prisma: {
      finding: { findMany: vi.fn() },
      scoreSnapshot: { findFirst: vi.fn() },
      workspaceMember: { findFirst: vi.fn() },
      scan: { findFirst: vi.fn() },
    },
  })
)

vi.mock("@/lib/cache", () => ({ getCachedSession, getCachedWorkspaceId }))
vi.mock("next/navigation", () => ({ notFound, redirect: vi.fn() }))
vi.mock("@lyrashield/db", () => ({
  getScanQualitySurface: vi.fn(),
  getScanWithEvents,
  getScanResultManifestDetail: vi.fn(),
  prisma,
}))

import ScanDetailPage from "./page"

describe("scan detail workspace authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCachedSession.mockResolvedValue({ userId: "member-1" })
    getCachedWorkspaceId.mockResolvedValue("workspace-1")
  })

  it("does not load or disclose a scan outside the active workspace", async () => {
    getScanWithEvents.mockResolvedValue(null)

    await expect(
      ScanDetailPage({ params: Promise.resolve({ id: "other-workspace-scan" }) })
    ).rejects.toThrow("NEXT_NOT_FOUND")

    expect(getScanWithEvents).toHaveBeenCalledWith("other-workspace-scan", "workspace-1")
    expect(prisma.finding.findMany).not.toHaveBeenCalled()
    expect(prisma.scoreSnapshot.findFirst).not.toHaveBeenCalled()
    expect(prisma.scan.findFirst).not.toHaveBeenCalled()
  })
})
