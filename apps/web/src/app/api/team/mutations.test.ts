import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  audit: vi.fn(),
  lock: vi.fn(),
  find: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  revoke: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({
  lockWorkspaceMembership: async (tx: { $queryRaw: () => Promise<unknown> }) => tx.$queryRaw(),
  prisma: { auditLog: { create: mocks.audit }, invitation: { updateMany: mocks.revoke } },
  withWorkspaceRLS: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: mocks.lock,
      workspaceMember: { findFirst: mocks.find, count: mocks.count, updateMany: mocks.update },
    }),
}))
vi.mock("@lyrashield/auth/server", () => ({
  requirePermission: mocks.permission,
  getSession: vi.fn(),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { error: vi.fn() } }))
vi.mock("@lyrashield/config", () => ({ env: {} }))
vi.mock("@lyrashield/integrations", () => ({ sendNotification: vi.fn() }))
vi.mock("../../../lib/rate-limit", () => ({ checkInvitationCreateRateLimit: vi.fn() }))
import { DELETE, PATCH } from "./route"
import { DELETE as revoke } from "./invitations/[id]/route"
import { PERMISSIONS } from "@lyrashield/auth"

function change(role = "MEMBER") {
  return PATCH(
    new Request("http://localhost/api/team", {
      method: "PATCH",
      body: JSON.stringify({ workspaceId: "ws-1", memberId: "member-1", role }),
    })
  )
}
function remove() {
  return DELETE(
    new Request("http://localhost/api/team?workspaceId=ws-1&memberId=member-1", {
      method: "DELETE",
    })
  )
}
function revokeInvite() {
  return revoke(
    new Request("http://localhost/api/team/invitations/invite-1?workspaceId=ws-1", {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: "invite-1" }) }
  )
}

describe("team mutations", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.permission.mockResolvedValue({ session: { userId: "actor-1" } })
    mocks.find
      .mockResolvedValueOnce({ role: "OWNER" })
      .mockResolvedValueOnce({ role: "MEMBER", userId: "target-1" })
    mocks.count.mockResolvedValue(2)
    mocks.update.mockResolvedValue({ count: 1 })
    mocks.revoke.mockResolvedValue({ count: 1 })
  })
  it.each([
    ["role", change, PERMISSIONS.member.updateRole],
    ["remove", remove, PERMISSIONS.member.remove],
    ["revoke", revokeInvite, PERMISSIONS.member.invite],
  ] as const)("gates %s and audits success", async (_name, run, permission) => {
    expect((await run()).status).toBe(200)
    expect(mocks.permission).toHaveBeenCalledWith("ws-1", permission)
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: "ws-1", actorUserId: "actor-1" }),
      })
    )
  })
  it.each([change, remove, revokeInvite])("rejects unauthenticated callers", async (run) => {
    mocks.permission.mockRejectedValue(new Error("UNAUTHORIZED"))
    expect((await run()).status).toBe(401)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it.each([change, remove, revokeInvite])("rejects callers without permission", async (run) => {
    mocks.permission.mockRejectedValue(new Error("FORBIDDEN"))
    expect((await run()).status).toBe(403)
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it.each([change, remove])("rechecks actor permissions under the lock", async (run) => {
    mocks.find
      .mockReset()
      .mockResolvedValueOnce({ role: "VIEWER" })
      .mockResolvedValueOnce({ role: "MEMBER" })
    expect((await run()).status).toBe(403)
    expect(mocks.lock).toHaveBeenCalledOnce()
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it.each([change, remove])("protects the final owner", async (run) => {
    mocks.find
      .mockReset()
      .mockResolvedValueOnce({ role: "OWNER" })
      .mockResolvedValueOnce({ role: "OWNER" })
    mocks.count.mockResolvedValue(1)
    expect((await run()).status).toBe(409)
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it.each(["ADMIN", "OWNER"])("prevents ADMIN granting %s", async (role) => {
    mocks.find
      .mockReset()
      .mockResolvedValueOnce({ role: "ADMIN" })
      .mockResolvedValueOnce({ role: "MEMBER" })
    expect((await change(role)).status).toBe(403)
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it.each([change, remove])("prevents an ADMIN managing an OWNER", async (run) => {
    mocks.find
      .mockReset()
      .mockResolvedValueOnce({ role: "ADMIN" })
      .mockResolvedValueOnce({ role: "OWNER" })
    expect((await run()).status).toBe(403)
  })
  it("scopes writes and refuses missing members", async () => {
    await remove()
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "member-1", workspaceId: "ws-1", status: "active" },
      data: { status: "removed" },
    })
    mocks.find.mockReset().mockResolvedValueOnce({ role: "OWNER" }).mockResolvedValueOnce(null)
    expect((await remove()).status).toBe(404)
  })
  it("only revokes pending invitations in the requested workspace", async () => {
    mocks.revoke.mockResolvedValue({ count: 0 })
    expect((await revokeInvite()).status).toBe(404)
    expect(mocks.revoke).toHaveBeenCalledWith({
      where: { id: "invite-1", workspaceId: "ws-1", status: "pending" },
      data: { status: "revoked" },
    })
    expect(mocks.audit).not.toHaveBeenCalled()
  })
  it("rejects unknown roles and extra payload fields", async () => {
    expect((await change("SUPERUSER")).status).toBe(400)
    expect(mocks.permission).not.toHaveBeenCalled()
  })
})
