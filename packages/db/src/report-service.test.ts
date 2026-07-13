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

  it("renders the immutable report snapshot without reloading live scan data", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      scanId: "scan-1",
      title: "Shared report",
      type: "executive",
      status: "generated",
      format: "html",
      contentJson: {
        version: 2,
        scanInfo: {
          scanId: "scan-1",
          status: "COMPLETED",
          summary: "Snapshot summary",
          targetName: "Snapshot target",
        },
        totalFindings: 3,
        findingsBySeverity: { HIGH: 2, MEDIUM: 1 },
        verifiedCount: 3,
        fixedCount: 1,
        findingsByStatus: { OPEN: 2, FIXED: 1 },
        findingsByCategory: { injection: 2, auth: 1 },
        retestSummary: { passed: 1, failed: 0, pending: 1 },
        assurance: {
          verdict: "GO_WITH_CONDITIONS",
          score: 74,
          grade: "B",
          narrative: "Two high-severity findings remain.",
          scoreTrend: [{ score: 74, grade: "B", computedAt: "2026-07-14T00:00:00.000Z" }],
          ageBuckets: { "0–7 days": 2, "8–30 days": 1 },
          priorityActions: [
            { label: "Assign remediation", detail: "Set owners.", severity: "HIGH" },
          ],
          methodology: ["Frozen at report creation time."],
        },
      },
      shareTokenHash: "hash",
      shareExpiresAt: null,
      revokedAt: null,
      createdAt: new Date("2026-07-14T00:00:00.000Z"),
    })

    const report = await getShareableReport("report-1", "ws-1")

    expect(report?.scanSummary).toEqual({
      scanId: "scan-1",
      status: "COMPLETED",
      summary: "Snapshot summary",
      targetName: "Private target",
      findingsCount: 3,
      findingsBySeverity: { HIGH: 2, MEDIUM: 1 },
    })
    expect(mockPrisma.scan.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.finding.findMany).not.toHaveBeenCalled()
    expect(report?.title).toBe("LyraShield Security Assurance Report")
    expect(report?.assurance).toEqual(
      expect.objectContaining({
        verdict: "GO_WITH_CONDITIONS",
        score: 74,
        verifiedCount: 3,
        fixedCount: 1,
      })
    )
  })
})
