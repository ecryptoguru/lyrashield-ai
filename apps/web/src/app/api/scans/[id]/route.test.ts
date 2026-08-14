import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((cb) => cb),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheTag: vi.fn(),
}))

vi.mock("@lyrashield/db", () => ({
  getScanWithEvents: vi.fn(),
  cancelScan: vi.fn(),
  removeScan: vi.fn(),
  prisma: { auditLog: { create: vi.fn() } },
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: vi.fn().mockResolvedValue({ session: { userId: "user-1" } }),
}))

vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { scan: { view: "scan:view", cancel: "scan:cancel" } },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { error: vi.fn() },
}))

import { DELETE, GET, POST } from "./route"
import { cancelScan, getScanWithEvents, prisma, removeScan } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"

const routeParams = { params: Promise.resolve({ id: "scan-1" }) }

describe("/api/scans/[id] workspace boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("requires an explicit workspace before reading a scan", async () => {
    const response = await GET(new Request("http://localhost/api/scans/scan-1"), routeParams)

    expect(response.status).toBe(400)
    expect(getScanWithEvents).not.toHaveBeenCalled()
  })

  it("authorizes and queries inside the requested workspace", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({ id: "scan-1", workspaceId: "ws-1" } as never)

    const response = await GET(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1"),
      routeParams
    )

    expect(response.status).toBe(200)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "scan:view")
    expect(getScanWithEvents).toHaveBeenCalledWith("scan-1", "ws-1")
  })

  it("binds cancellation to the authorized workspace", async () => {
    vi.mocked(getScanWithEvents).mockResolvedValue({ id: "scan-1", workspaceId: "ws-1" } as never)
    vi.mocked(cancelScan).mockResolvedValue({
      id: "scan-1",
      status: "CANCELLED",
      endedAt: new Date(),
    } as never)

    const response = await POST(
      new Request("http://localhost/api/scans/scan-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-1" }),
      }),
      routeParams
    )

    expect(response.status).toBe(200)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "scan:cancel")
    expect(cancelScan).toHaveBeenCalledWith("scan-1", "ws-1")
  })

  it("removes a terminal scan from the authorized workspace", async () => {
    vi.mocked(removeScan).mockResolvedValue({ id: "scan-1" } as never)

    const response = await DELETE(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1", { method: "DELETE" }),
      routeParams
    )

    expect(response.status).toBe(200)
    expect(requirePermission).toHaveBeenCalledWith("ws-1", "scan:cancel")
    expect(removeScan).toHaveBeenCalledWith("scan-1", "ws-1")
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          actorUserId: "user-1",
          action: "scan.removed",
          resourceType: "scan",
          resourceId: "scan-1",
        }),
      })
    )
  })

  it("returns SCAN_NOT_FOUND when the scan is not in the authorized workspace", async () => {
    vi.mocked(removeScan).mockRejectedValue(new Error("Scan not found: scan-1"))

    const response = await DELETE(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1", { method: "DELETE" }),
      routeParams
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SCAN_NOT_FOUND" },
    })
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("returns SCAN_ACTIVE without removing an active scan", async () => {
    vi.mocked(removeScan).mockRejectedValue(new Error("Cannot remove an active scan"))

    const response = await DELETE(
      new Request("http://localhost/api/scans/scan-1?workspaceId=ws-1", { method: "DELETE" }),
      routeParams
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SCAN_ACTIVE" } })
    expect(prisma.auditLog.create).not.toHaveBeenCalled()
  })

  it("rejects a blank scan id before authorizing or querying the database", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/scans/%20%20%20?workspaceId=ws-1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "   " }) }
    )

    expect(response.status).toBe(400)
    expect(requirePermission).not.toHaveBeenCalled()
    expect(removeScan).not.toHaveBeenCalled()
  })
})
