import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@lyrashield/db", () => ({
  getScanWithEvents: vi.fn(),
  cancelScan: vi.fn(),
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

import { GET, POST } from "./route"
import { cancelScan, getScanWithEvents } from "@lyrashield/db"
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
})
