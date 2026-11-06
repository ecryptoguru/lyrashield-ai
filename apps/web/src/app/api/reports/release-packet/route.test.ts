import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  assertScope: vi.fn(),
  issueReleasePacket: vi.fn(),
  generateShareToken: vi.fn(),
  resolveKey: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: mocks.requirePermission,
  assertOAuthDelegatedScope: mocks.assertScope,
  getSession: vi.fn().mockResolvedValue({ userId: "user-1" }),
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { create: "report:create" } } }))
vi.mock("@lyrashield/db", () => ({
  issueReleasePacket: mocks.issueReleasePacket,
  generateShareToken: mocks.generateShareToken,
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
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }))
vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example.test" } }))

import { POST } from "./route"

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
    mocks.issueReleasePacket.mockResolvedValue({
      reportId: "report-1",
      payload: { packetChecksum: "a".repeat(64) },
    })
    mocks.generateShareToken.mockResolvedValue({ token: "b".repeat(64) })
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
      })
    )
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
})
