import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: { scan: { findFirst: vi.fn() } },
  listReports: vi.fn(),
  createReport: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  assertOAuthDelegatedScope: vi.fn(),
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { report: { create: "report:create", download: "report:download" } },
}))

vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))
vi.mock("../../../lib/cache", () => ({ revalidateDashboardAggregates: vi.fn() }))

import { POST } from "./route"
import { prisma, createReport } from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"

describe("POST /api/reports", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({ session: { userId: "user-1" } } as never)
  })

  it("rejects a scan that does not belong to the requested workspace", async () => {
    vi.mocked(prisma.scan.findFirst).mockResolvedValue(null as never)

    const response = await POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws-1",
          scanId: "scan-other-workspace",
          title: "Report",
        }),
      })
    )

    expect(await response.json()).toMatchObject({ error: { code: "SCAN_NOT_FOUND" } })
    expect(response.status).toBe(404)
    expect(createReport).not.toHaveBeenCalled()
  })

  it("resolves a target-scoped report to its latest completed scan", async () => {
    vi.mocked(prisma.scan.findFirst).mockResolvedValue({ id: "scan-latest" } as never)
    vi.mocked(createReport).mockResolvedValue({
      id: "report-1",
      title: "Report",
      status: "generated",
    } as never)

    const response = await POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws-1",
          targetId: "target-1",
          title: "Report",
        }),
      })
    )

    expect(prisma.scan.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "ws-1",
        targetId: "target-1",
        status: "COMPLETED",
        deletedAt: null,
      },
      orderBy: [{ endedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    })
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", scanId: "scan-latest" })
    )
    expect(assertOAuthDelegatedScope).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "target-1"
    )
    expect(response.status).toBe(201)
  })

  it("reports immutable snapshot reuse without claiming a new report was created", async () => {
    vi.mocked(prisma.scan.findFirst).mockResolvedValue({ id: "scan-latest" } as never)
    vi.mocked(createReport).mockResolvedValue({
      id: "report-existing",
      title: "Original snapshot",
      status: "generated",
      snapshotReused: true,
    } as never)

    const response = await POST(
      new Request("http://localhost/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws-1",
          targetId: "target-1",
          title: "Requested title",
        }),
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: {
        id: "report-existing",
        title: "Original snapshot",
        requestedTitle: "Requested title",
        snapshotReused: true,
      },
    })
  })
})
