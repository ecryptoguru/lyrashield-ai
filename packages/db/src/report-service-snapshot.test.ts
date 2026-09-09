import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: { report: { create: vi.fn(), findFirst: vi.fn() } },
}))
vi.mock("./report-generator", () => ({ gatherReportData: vi.fn() }))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }))

import { prisma } from "./client"
import { gatherReportData } from "./report-generator"
import { createReport } from "./report-service"

describe("report snapshots", () => {
  beforeEach(() => vi.clearAllMocks())

  it("persists creation-time report data", async () => {
    const snapshot = { generatedAt: "2026-07-14T00:00:00.000Z", findings: [{ id: "finding-1" }] }
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null)
    vi.mocked(gatherReportData).mockResolvedValue(snapshot as never)
    vi.mocked(prisma.report.create).mockResolvedValue({ id: "report-1" } as never)

    await createReport({
      workspaceId: "workspace-1",
      scanId: "scan-1",
      title: "Snapshot",
      createdById: "user-1",
    })

    expect(prisma.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contentJson: snapshot, scanId: "scan-1" }),
    })
  })

  // W3-05: one private snapshot per scan+type despite duplicate completion
  // events; a retry returns the existing snapshot and never re-gathers or
  // replays the scan.
  it("reuses the existing snapshot for the same scan+type", async () => {
    const existing = { id: "report-existing", scanId: "scan-1", type: "developer" }
    vi.mocked(prisma.report.findFirst).mockResolvedValue(existing as never)

    const report = await createReport({
      workspaceId: "workspace-1",
      scanId: "scan-1",
      title: "Retry",
      createdById: "user-1",
      type: "developer",
    })

    expect(report.id).toBe("report-existing")
    expect(prisma.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace-1",
          scanId: "scan-1",
          type: "developer",
          deletedAt: null,
        }),
      })
    )
    expect(gatherReportData).not.toHaveBeenCalled()
    expect(prisma.report.create).not.toHaveBeenCalled()
  })

  it("does not dedupe workspace-level reports without a scan", async () => {
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null)
    vi.mocked(gatherReportData).mockResolvedValue({} as never)
    vi.mocked(prisma.report.create).mockResolvedValue({ id: "report-2" } as never)

    await createReport({
      workspaceId: "workspace-1",
      title: "Workspace report",
      createdById: "user-1",
    })

    expect(prisma.report.findFirst).not.toHaveBeenCalled()
    expect(prisma.report.create).toHaveBeenCalledTimes(1)
  })

  it("treats different report types for the same scan as separate snapshots", async () => {
    vi.mocked(prisma.report.findFirst).mockResolvedValue(null)
    vi.mocked(gatherReportData).mockResolvedValue({} as never)
    vi.mocked(prisma.report.create).mockResolvedValue({ id: "report-2" } as never)

    await createReport({
      workspaceId: "workspace-1",
      scanId: "scan-1",
      title: "Executive view",
      createdById: "user-1",
      type: "executive",
    })

    expect(prisma.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: "executive" }),
      })
    )
    expect(prisma.report.create).toHaveBeenCalledTimes(1)
  })
})
