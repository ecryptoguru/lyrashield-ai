import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./client", () => ({
  prisma: { report: { create: vi.fn() } },
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
})
