import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  updateMany: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { member: { invite: "member:invite" } } }))
vi.mock("@lyrashield/db", () => ({
  prisma: { invitation: { updateMany: mocks.updateMany }, auditLog: { create: mocks.auditCreate } },
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import { DELETE } from "./route"

function call() {
  return DELETE(
    new Request("http://localhost/api/team/invitations/invitation-1?workspaceId=workspace-1", {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: "invitation-1" }) }
  )
}

describe("DELETE /api/team/invitations/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.auditCreate.mockResolvedValue({})
  })

  it("revokes and audits a pending invitation for a member manager", async () => {
    expect((await call()).status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "member:invite")
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "invitation-1", workspaceId: "workspace-1", status: "pending" },
      data: { status: "revoked" },
    })
    expect(mocks.auditCreate).toHaveBeenCalled()
  })

  it("does not revoke an invitation without member:invite", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    expect((await call()).status).toBe(403)
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })
})
