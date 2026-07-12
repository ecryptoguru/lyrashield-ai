import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    report: { findFirst: vi.fn() },
    scan: { findFirst: vi.fn() },
    finding: { findMany: vi.fn() },
  },
}))

import { prisma } from "./client"
import { getShareableReport } from "./report-service"

const mockPrisma = prisma as unknown as {
  report: { findFirst: ReturnType<typeof vi.fn> }
  scan: { findFirst: ReturnType<typeof vi.fn> }
  finding: { findMany: ReturnType<typeof vi.fn> }
}

describe("getShareableReport", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("does not load a scan outside the report workspace", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: "scan-other-workspace",
      title: "Shared report",
      type: "developer",
      status: "generated",
      format: "html",
      shareTokenHash: "hash",
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    })
    mockPrisma.scan.findFirst.mockResolvedValue(null)

    const report = await getShareableReport("report-1", "ws-1")

    expect(report?.scanSummary).toBeNull()
    expect(mockPrisma.scan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "scan-other-workspace", workspaceId: "ws-1", deletedAt: null },
      })
    )
  })
})
