import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
  getSession: vi.fn(),
  requirePermission: vi.fn(),
  getReportByShareToken: vi.fn(),
  getReleasePacket: vi.fn(),
  getReleasePacketForDelegatedRead: vi.fn(),
}))

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { download: "report:download" } } }))
vi.mock("@lyrashield/auth/server", () => ({
  getSession: mocks.getSession,
  requirePermission: mocks.requirePermission,
}))
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
vi.mock("./release-packet-view", () => ({ ReleasePacketView: () => null }))
vi.mock("@lyrashield/billing", () => ({
  resolveReleasePacketVerificationKeys: vi.fn().mockResolvedValue([]),
  resolveLaunchReportSigningPublicKey: vi.fn().mockResolvedValue(null),
}))

import PrivateReleasePacketPage from "./page"

const token = "b".repeat(64)
const verification = { verificationKeys: [], assessmentPublicKey: null }
const params = Promise.resolve({ id: "report-1" })
const searchParams = Promise.resolve({ token })

describe("PrivateReleasePacketPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getReportByShareToken.mockResolvedValue({
      id: "report-1",
      workspaceId: "ws-1",
      shareExpiresAt: new Date(Date.now() + 60_000),
    })
    mocks.getSession.mockResolvedValue({ userId: "user-1" })
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
  })

  it("reads a non-delegated packet with the private token re-proved in the transaction", async () => {
    mocks.getReleasePacket.mockResolvedValue({ payload: { packetChecksum: "a".repeat(64) } })

    await PrivateReleasePacketPage({ params, searchParams })

    expect(mocks.getReleasePacket).toHaveBeenCalledWith("report-1", "ws-1", {
      shareToken: token,
      ...verification,
    })
  })

  it("enforces live delegated authority for a selected-target session", async () => {
    mocks.requirePermission.mockResolvedValue({
      session: {
        userId: "user-1",
        oauth: {
          connectionId: "conn-1",
          authorizationVersion: 4,
          workspaceId: "ws-1",
          allTargets: false,
          allowedTargetIds: ["target-1"],
        },
      },
    })
    mocks.getReleasePacketForDelegatedRead.mockResolvedValue(null)

    await expect(PrivateReleasePacketPage({ params, searchParams })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    )

    expect(mocks.getReleasePacketForDelegatedRead).toHaveBeenCalledWith({
      reportId: "report-1",
      workspaceId: "ws-1",
      userId: "user-1",
      connectionId: "conn-1",
      authorizationVersion: 4,
      shareToken: token,
      ...verification,
    })
    expect(mocks.getReleasePacket).not.toHaveBeenCalled()
    expect(mocks.notFound).toHaveBeenCalled()
  })

  it("hides a packet whose stored snapshot no longer verifies", async () => {
    const { ReleasePacketError } = await import("@lyrashield/db")
    mocks.getReleasePacket.mockRejectedValue(
      new ReleasePacketError("SNAPSHOT_INVALID", "checksum mismatch")
    )

    await expect(PrivateReleasePacketPage({ params, searchParams })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    )
  })
})
