import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getSession: vi.fn(),
  share: vi.fn(),
  revoke: vi.fn(),
  withAuthority: vi.fn(),
}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: mocks.requirePermission,
  getSession: mocks.getSession,
  resolveOAuthReadScope: vi.fn(),
}))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { report: { create: "report:create" } } }))
vi.mock("@lyrashield/db", () => ({
  generateReleasePacketShareToken: mocks.share,
  revokeReleasePacketShareToken: mocks.revoke,
  withDelegatedReadAuthority: mocks.withAuthority,
  getDelegatedActiveTargetIds: vi.fn(),
  getDelegatedScanAccess: vi.fn(),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))
vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost" } }))

import { POST } from "./route"

const params = { params: Promise.resolve({ id: "packet-fixture" }) }
const member = { id: "member-fixture", role: "OWNER", updatedAt: new Date("2026-11-11T00:00:00Z") }
const client = {}
const authority = { targetIds: ["target-fixture"], allowedProfiles: ["STANDARD"] }
const session = { userId: "user-fixture" }
const expiresAt = new Date("2030-01-01T00:00:00Z")
const token = "a".repeat(64)
function request(action: string, workspaceId = "workspace-fixture") {
  return new Request("http://localhost/api/reports/release-packet/packet-fixture", {
    method: "POST",
    body: JSON.stringify({ workspaceId, action }),
  })
}

describe("packet-specific private link mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session, workspace: { member } })
    mocks.getSession.mockResolvedValue(session)
    mocks.share.mockResolvedValue({ token, tokenHash: "private-hash", expiresAt })
    mocks.revoke.mockResolvedValue(expiresAt)
    mocks.withAuthority.mockImplementation(async (_principal, run) => run(client, authority))
  })

  it("creates or rotates only a packet-specific private URL without returning its hash", async () => {
    const response = await POST(request("share"), params)
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    const body = await response.json()
    expect(body.data).toEqual({
      token,
      expiresAt: expiresAt.toISOString(),
      shareUrl: `/reports/release-packet/shared/packet-fixture?token=${token}&workspaceId=workspace-fixture`,
    })
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-fixture", "report:create")
    expect(mocks.share).toHaveBeenCalledWith("packet-fixture", "workspace-fixture", {})
    expect(JSON.stringify(body)).not.toContain("tokenHash")
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it("revokes a packet under the existing report:create mutation permission", async () => {
    const response = await POST(request("revoke"), params)
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { revoked: true, revokedAt: expiresAt.toISOString() },
    })
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-fixture", "report:create")
    expect(mocks.revoke).toHaveBeenCalledWith("packet-fixture", "workspace-fixture", {})
    expect(mocks.share).not.toHaveBeenCalled()
  })

  it.each(["share", "revoke"])(
    "holds current delegated membership and grants through %s",
    async (action) => {
      mocks.requirePermission.mockResolvedValue({
        session: {
          ...session,
          oauth: {
            connectionId: "connection-fixture",
            authorizationVersion: 4,
            workspaceId: "workspace-fixture",
          },
        },
        workspace: { member },
      })
      const response = await POST(request(action), params)
      expect(response.status).toBe(200)
      expect(mocks.withAuthority).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-fixture",
          userId: "user-fixture",
          memberId: member.id,
          memberRole: member.role,
          memberUpdatedAt: member.updatedAt,
          connectionId: "connection-fixture",
          authorizationVersion: 4,
          requiredOperation: "report.create",
        }),
        expect.any(Function)
      )
      const mutate = action === "share" ? mocks.share : mocks.revoke
      expect(mutate).toHaveBeenCalledWith("packet-fixture", "workspace-fixture", {
        client,
        authority,
      })
    }
  )

  it.each(["share", "revoke"])("denies %s without current workspace permission", async (action) => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))
    const response = await POST(request(action), params)
    expect(response.status).toBe(403)
    expect(mocks.share).not.toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it.each(["share", "revoke"])(
    "denies revoked or narrowed delegated authority for %s",
    async (action) => {
      mocks.requirePermission.mockResolvedValue({
        session: {
          ...session,
          oauth: {
            connectionId: "connection-fixture",
            authorizationVersion: 4,
            workspaceId: "workspace-fixture",
          },
        },
        workspace: { member },
      })
      mocks.withAuthority.mockRejectedValue(new Error("FORBIDDEN"))
      expect((await POST(request(action), params)).status).toBe(403)
      expect(mocks.share).not.toHaveBeenCalled()
      expect(mocks.revoke).not.toHaveBeenCalled()
    }
  )

  it.each([
    { connectionId: "connection-fixture", workspaceId: "workspace-fixture" },
    { connectionId: "connection-fixture", authorizationVersion: 4, workspaceId: "other-workspace" },
  ])("denies malformed or cross-workspace OAuth authority before mutation", async (oauth) => {
    mocks.requirePermission.mockResolvedValue({
      session: { ...session, oauth },
      workspace: { member },
    })
    expect((await POST(request("revoke"), params)).status).toBe(403)
    expect(mocks.withAuthority).not.toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })

  it.each(["share", "revoke"])(
    "404s a cross-workspace, missing or non-packet %s match",
    async (action) => {
      const mutate = action === "share" ? mocks.share : mocks.revoke
      mutate.mockRejectedValue(new Error("Report not found"))
      expect((await POST(request(action, "other-workspace"), params)).status).toBe(404)
      expect(mutate).toHaveBeenCalledWith("packet-fixture", "other-workspace", {})
    }
  )

  it("rejects cross-origin browser mutations before permission or token access", async () => {
    const response = await POST(
      new Request("http://localhost/api/reports/release-packet/packet-fixture", {
        method: "POST",
        headers: { cookie: "session=fixture", origin: "http://attacker.invalid" },
        body: JSON.stringify({ workspaceId: "workspace-fixture", action: "revoke" }),
      }),
      params
    )
    expect(response.status).toBe(403)
    expect(mocks.requirePermission).not.toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
})
