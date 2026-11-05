import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getReportByShareToken: vi.fn(),
  getReleasePacket: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { download: "report:download" } } }))
vi.mock("@lyrashield/db", () => ({
  getReportByShareToken: mocks.getReportByShareToken,
  getReleasePacket: mocks.getReleasePacket,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { GET } from "./route"

describe("private shared release packet", () => {
  beforeEach(() => vi.clearAllMocks())

  it("requires both a live token and authorized workspace session", async () => {
    mocks.getReportByShareToken.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      shareExpiresAt: new Date(Date.now() + 60_000),
    })
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.getReleasePacket.mockResolvedValue({ packetChecksum: "a".repeat(64) })

    const response = await GET(
      new Request(
        `http://localhost/api/reports/release-packet/shared/report-1?token=${"b".repeat(64)}`
      ),
      { params: Promise.resolve({ id: "report-1" }) }
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mocks.requirePermission).toHaveBeenCalledWith("ws-1", "report:download")
    expect(mocks.getReleasePacket).toHaveBeenCalledWith("report-1", "ws-1")
  })

  it("does not disclose a report for an unknown or mismatched token", async () => {
    mocks.getReportByShareToken.mockResolvedValue({
      id: "other-report",
      workspaceId: "ws-1",
      shareExpiresAt: new Date(Date.now() + 60_000),
    })
    const response = await GET(
      new Request(
        `http://localhost/api/reports/release-packet/shared/report-1?token=${"b".repeat(64)}`
      ),
      { params: Promise.resolve({ id: "report-1" }) }
    )
    expect(response.status).toBe(404)
    expect(mocks.requirePermission).not.toHaveBeenCalled()
  })
})
