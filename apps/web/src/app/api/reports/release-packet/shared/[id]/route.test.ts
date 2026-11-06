import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getReportByShareToken: vi.fn(),
  getReleasePacket: vi.fn(),
  getReleasePacketForDelegatedRead: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { download: "report:download" } } }))
vi.mock("@lyrashield/db", () => ({
  getReportByShareToken: mocks.getReportByShareToken,
  getReleasePacket: mocks.getReleasePacket,
  getReleasePacketForDelegatedRead: mocks.getReleasePacketForDelegatedRead,
  ReleasePacketError: class ReleasePacketError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  },
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))

import { GET } from "./route"

const token = "b".repeat(64)

function request() {
  return new Request(`http://localhost/api/reports/release-packet/shared/report-1?token=${token}`)
}

describe("private shared release packet", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getReportByShareToken.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      shareExpiresAt: new Date(Date.now() + 60_000),
    })
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
  })

  it("requires both a live token and authorized workspace session", async () => {
    mocks.getReleasePacket.mockResolvedValue({ packetChecksum: "a".repeat(64) })

    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(mocks.requirePermission).toHaveBeenCalledWith("ws-1", "report:download")
    expect(mocks.getReleasePacket).toHaveBeenCalledWith("report-1", "ws-1", { shareToken: token })
  })

  it("does not disclose a report for an unknown or mismatched token", async () => {
    mocks.getReportByShareToken.mockResolvedValue({
      id: "other-report",
      workspaceId: "ws-1",
      shareExpiresAt: new Date(Date.now() + 60_000),
    })
    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })
    expect(response.status).toBe(404)
    expect(mocks.requirePermission).not.toHaveBeenCalled()
  })

  it("re-reads the live token capability inside the packet transaction", async () => {
    mocks.getReleasePacket.mockResolvedValue(null)

    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(404)
    expect(mocks.getReleasePacket).toHaveBeenCalledWith("report-1", "ws-1", { shareToken: token })
  })

  it("reads a delegated packet under the live connection authority and token", async () => {
    mocks.requirePermission.mockResolvedValue({
      session: {
        userId: "user-1",
        oauth: {
          connectionId: "conn-1",
          authorizationVersion: 2,
          workspaceId: "ws-1",
          allTargets: false,
          allowedTargetIds: ["target-1"],
        },
      },
    })
    mocks.getReleasePacketForDelegatedRead.mockResolvedValue({ packetChecksum: "a".repeat(64) })

    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(200)
    expect(mocks.getReleasePacketForDelegatedRead).toHaveBeenCalledWith({
      reportId: "report-1",
      workspaceId: "ws-1",
      userId: "user-1",
      connectionId: "conn-1",
      authorizationVersion: 2,
      shareToken: token,
    })
    expect(mocks.getReleasePacket).not.toHaveBeenCalled()
  })

  it("returns 404 when the live delegated grant no longer covers the packet", async () => {
    mocks.requirePermission.mockResolvedValue({
      session: {
        userId: "user-1",
        oauth: {
          connectionId: "conn-1",
          authorizationVersion: 2,
          workspaceId: "ws-1",
          allTargets: false,
          allowedTargetIds: ["target-1"],
        },
      },
    })
    mocks.getReleasePacketForDelegatedRead.mockResolvedValue(null)

    const response = await GET(request(), { params: Promise.resolve({ id: "report-1" }) })

    expect(response.status).toBe(404)
    expect(mocks.getReleasePacket).not.toHaveBeenCalled()
  })
})
