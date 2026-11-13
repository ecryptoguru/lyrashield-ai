import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  updateStatus: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { notification: { view: "notification:view", manage: "notification:manage" } },
}))
vi.mock("@lyrashield/db", () => ({
  updateNotificationStatus: mocks.updateStatus,
  prisma: { auditLog: { create: mocks.auditCreate } },
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import { PATCH } from "./route"

function call(action: "mark_read" | "mark_sent") {
  return PATCH(
    new Request("http://localhost/api/notifications/notification-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-1", action }),
    }),
    { params: Promise.resolve({ id: "notification-1" }) }
  )
}

describe("PATCH /api/notifications/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.updateStatus.mockResolvedValue({ id: "notification-1", status: "read" })
    mocks.auditCreate.mockResolvedValue({})
  })

  it("allows a member to mark their own notification read with view permission", async () => {
    expect((await call("mark_read")).status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "notification:view")
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "notification-1",
      "workspace-1",
      "read",
      "user-1"
    )
  })

  it("requires notification:manage for workspace-wide send status changes", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    expect((await call("mark_sent")).status).toBe(403)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "notification:manage")
    expect(mocks.updateStatus).not.toHaveBeenCalled()
  })
})
