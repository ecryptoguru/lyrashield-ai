import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getWorkspaceId: vi.fn(),
  requirePermission: vi.fn(),
  getPacket: vi.fn(),
  getDelegatedPacket: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT")
  }),
}))

vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }))
vi.mock("@/lib/cache", () => ({
  getCachedSession: mocks.getSession,
  getCachedWorkspaceId: mocks.getWorkspaceId,
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { download: "report:download" } } }))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/db", () => ({
  getReleasePacket: mocks.getPacket,
  getReleasePacketForDelegatedRead: mocks.getDelegatedPacket,
  ReleasePacketError: class ReleasePacketError extends Error {},
}))
vi.mock("@/lib/release-packet-verification", () => ({
  releasePacketVerificationContext: vi
    .fn()
    .mockResolvedValue({ verificationKeys: [], assessmentPublicKey: null }),
}))
vi.mock("@/app/reports/release-packet/shared/[id]/release-packet-view", () => ({
  ReleasePacketView: () => null,
}))

const params = Promise.resolve({ id: "packet-1" })

describe("workspace release packet page", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({ userId: "user-1" })
    mocks.getWorkspaceId.mockResolvedValue("ws-1")
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.getPacket.mockResolvedValue({ payload: { packetChecksum: "a".repeat(64) } })
  })

  it("opens the selected workspace packet without a share token", async () => {
    const { default: Page } = await import("./page")
    const result = await Page({ params })
    expect(mocks.requirePermission).toHaveBeenCalledWith("ws-1", "report:download")
    expect(mocks.getPacket).toHaveBeenCalledWith("packet-1", "ws-1", {
      verificationKeys: [],
      assessmentPublicKey: null,
    })
    expect(result.props).toMatchObject({
      workspaceId: "ws-1",
      reportId: "packet-1",
      workspaceView: true,
    })
  })

  it("denies an unauthorized workspace before reading packet data", async () => {
    const { default: Page } = await import("./page")
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))
    await expect(Page({ params })).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.getPacket).not.toHaveBeenCalled()
  })

  it("does not show a missing or invalid packet", async () => {
    const { default: Page } = await import("./page")
    mocks.getPacket.mockResolvedValue(null)
    await expect(Page({ params })).rejects.toThrow("NEXT_NOT_FOUND")
    const { ReleasePacketError } = await import("@lyrashield/db")
    mocks.getPacket.mockRejectedValue(
      new ReleasePacketError("SNAPSHOT_INVALID", "Invalid checksum")
    )
    await expect(Page({ params })).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("redirects an unauthenticated visitor without looking up the workspace", async () => {
    const { default: Page } = await import("./page")
    mocks.getSession.mockResolvedValue(null)
    await expect(Page({ params })).rejects.toThrow("NEXT_REDIRECT")
    expect(mocks.redirect).toHaveBeenCalledWith("/sign-in")
    expect(mocks.getWorkspaceId).not.toHaveBeenCalled()
  })

  it("requires current delegated target and profile authority for OAuth", async () => {
    const { default: Page } = await import("./page")
    mocks.requirePermission.mockResolvedValue({
      session: {
        userId: "user-1",
        oauth: { connectionId: "conn-1", authorizationVersion: 4, workspaceId: "ws-1" },
      },
    })
    mocks.getDelegatedPacket.mockResolvedValue(null)
    await expect(Page({ params })).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.getDelegatedPacket).toHaveBeenCalledWith({
      reportId: "packet-1",
      workspaceId: "ws-1",
      userId: "user-1",
      connectionId: "conn-1",
      authorizationVersion: 4,
      verificationKeys: [],
      assessmentPublicKey: null,
    })
    expect(mocks.getPacket).not.toHaveBeenCalled()
  })

  it("rejects a malformed or cross-workspace OAuth grant before reading the packet", async () => {
    const { default: Page } = await import("./page")
    mocks.requirePermission.mockResolvedValue({
      session: {
        userId: "user-1",
        oauth: { connectionId: "conn-1", authorizationVersion: 4, workspaceId: "other" },
      },
    })
    await expect(Page({ params })).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.getDelegatedPacket).not.toHaveBeenCalled()
    expect(mocks.getPacket).not.toHaveBeenCalled()
  })
})
