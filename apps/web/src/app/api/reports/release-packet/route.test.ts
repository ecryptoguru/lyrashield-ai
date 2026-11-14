import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  assertScope: vi.fn(),
  issueReleasePacket: vi.fn(),
  generateReleasePacketShareToken: vi.fn(),
  resolveKey: vi.fn(),
  resolvePrivateKey: vi.fn(),
  resolveVerificationKeys: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: mocks.requirePermission,
  assertOAuthDelegatedScope: mocks.assertScope,
  getSession: vi.fn().mockResolvedValue({ userId: "user-1" }),
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { create: "report:create" } } }))
vi.mock("@lyrashield/db", () => ({
  issueReleasePacket: mocks.issueReleasePacket,
  generateReleasePacketShareToken: mocks.generateReleasePacketShareToken,
  ReleasePacketError: class ReleasePacketError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  },
}))
vi.mock("@lyrashield/billing", () => ({
  resolveLaunchReportSigningPublicKey: mocks.resolveKey,
  resolveLaunchReportSigningPrivateKey: mocks.resolvePrivateKey,
  resolveReleasePacketVerificationKeys: mocks.resolveVerificationKeys,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example.test" } }))

import { POST } from "./route"
import { ReleasePacketError } from "@lyrashield/db"

function request(body: unknown) {
  return new Request("http://localhost/api/reports/release-packet", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "session=test",
      origin: "https://app.example.test",
    },
    body: JSON.stringify(body),
  })
}

describe("POST /api/reports/release-packet", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.resolveKey.mockResolvedValue("public-key")
    mocks.resolvePrivateKey.mockResolvedValue("private-key")
    mocks.resolveVerificationKeys.mockResolvedValue([
      { id: "key", publicKey: "public-key", revoked: false },
    ])
    mocks.issueReleasePacket.mockResolvedValue({
      reportId: "report-1",
      payload: { packetChecksum: "a".repeat(64) },
    })
    mocks.generateReleasePacketShareToken.mockResolvedValue({ token: "b".repeat(64) })
  })

  it("issues an exact-release packet and returns a revocable private link", async () => {
    const response = await POST(
      request({
        workspaceId: "ws-1",
        targetId: "target-1",
        commit: "c".repeat(40),
        share: true,
      })
    )
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(mocks.issueReleasePacket).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        targetId: "target-1",
        actorUserId: "user-1",
        expectedIdentity: { kind: "COMMIT", value: "c".repeat(40) },
        signingPublicKey: "public-key",
        signingPrivateKey: "private-key",
        verificationKeys: [{ id: "key", publicKey: "public-key", revoked: false }],
      })
    )
    expect(mocks.generateReleasePacketShareToken).toHaveBeenCalledWith("report-1", "ws-1")
    expect(body.data).toEqual({
      reportId: "report-1",
      packetChecksum: "a".repeat(64),
      shareUrl: `https://app.example.test/reports/release-packet/shared/report-1?token=${"b".repeat(64)}&workspaceId=ws-1`,
    })
  })

  it("rejects ambiguity or malformed release identity before mutation", async () => {
    const response = await POST(
      request({
        workspaceId: "ws-1",
        targetId: "target-1",
        commit: "c".repeat(40),
        artifactDigest: `sha256:${"d".repeat(64)}`,
      })
    )
    expect(response.status).toBe(400)
    expect(mocks.issueReleasePacket).not.toHaveBeenCalled()
  })

  it("fails closed when packet signing is unavailable", async () => {
    mocks.resolvePrivateKey.mockRejectedValue(new Error("key unavailable"))
    mocks.issueReleasePacket.mockRejectedValue(
      new ReleasePacketError("SIGNING_UNAVAILABLE", "Signing unavailable")
    )
    const response = await POST(
      request({ workspaceId: "ws-1", targetId: "target-1", commit: "c".repeat(40) })
    )
    expect(response.status).toBe(503)
    expect(mocks.issueReleasePacket).toHaveBeenCalledWith(
      expect.objectContaining({ signingPrivateKey: null })
    )
    expect(mocks.generateReleasePacketShareToken).not.toHaveBeenCalled()
  })
})
