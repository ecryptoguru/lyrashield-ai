import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  createNotification: vi.fn(),
  markAllRead: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { notification: { view: "notification:view", manage: "notification:manage" } },
}))
vi.mock("@lyrashield/db", () => ({
  createNotification: mocks.createNotification,
  markAllNotificationsRead: mocks.markAllRead,
  prisma: { auditLog: { create: mocks.auditCreate } },
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn() },
}))

import { PATCH, POST } from "./route"

function request(method: "POST" | "PATCH", body: unknown) {
  return new Request("http://localhost/api/notifications", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("notification mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.createNotification.mockResolvedValue({ id: "notification-1" })
    mocks.markAllRead.mockResolvedValue(2)
    mocks.auditCreate.mockResolvedValue({})
  })

  it("creates a notification only with notification:manage", async () => {
    const response = await POST(
      request("POST", {
        workspaceId: "workspace-1",
        type: "security_alert",
        title: "Review required",
        body: "A security review needs attention.",
      })
    )

    expect(response.status).toBe(201)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "notification:manage")
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", userId: "user-1" })
    )
  })

  it("denies notification creation without notification:manage", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))

    expect(
      (
        await POST(
          request("POST", {
            workspaceId: "workspace-1",
            type: "security_alert",
            title: "Review required",
            body: "A security review needs attention.",
          })
        )
      ).status
    ).toBe(403)
    expect(mocks.createNotification).not.toHaveBeenCalled()
  })

  it("marks only the current user's notifications read with view permission", async () => {
    const response = await PATCH(
      request("PATCH", { workspaceId: "workspace-1", action: "mark_all_read" })
    )

    expect(response.status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "notification:view")
    expect(mocks.markAllRead).toHaveBeenCalledWith("workspace-1", "user-1")
  })

  it("denies mark-all-read when notification:view is unavailable", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("FORBIDDEN"))

    expect(
      (await PATCH(request("PATCH", { workspaceId: "workspace-1", action: "mark_all_read" })))
        .status
    ).toBe(403)
    expect(mocks.markAllRead).not.toHaveBeenCalled()
  })
})
