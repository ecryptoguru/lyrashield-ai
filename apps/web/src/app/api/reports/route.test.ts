import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  prisma: { scan: { findFirst: vi.fn() } },
  listReports: vi.fn(),
  createReport: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { report: { create: "report:create", download: "report:download" } },
}))

vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { POST } from "./route"
import { prisma, createReport } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"

describe("POST /api/reports", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requirePermission).mockResolvedValue({ session: { userId: "user-1" } } as never)
  })

  it("rejects a scan that does not belong to the requested workspace", async () => {
    vi.mocked(prisma.scan.findFirst).mockResolvedValue(null as never)

    const response = await POST(new Request("http://localhost/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws-1",
        scanId: "scan-other-workspace",
        title: "Report",
      }),
    }))

    expect(await response.json()).toMatchObject({ error: { code: "SCAN_NOT_FOUND" } })
    expect(response.status).toBe(404)
    expect(createReport).not.toHaveBeenCalled()
  })
})
