import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  setStatus: vi.fn(),
  auditCreate: vi.fn(),
}))

vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { integration: { manage: "integration:manage" } },
}))
vi.mock("@lyrashield/db", () => ({
  setConnectorConnectionStatus: mocks.setStatus,
  prisma: { auditLog: { create: mocks.auditCreate } },
}))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import { POST } from "./route"

function call() {
  return POST(
    new Request("http://localhost/api/integrations/connectors/connector-1/disable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-1", reason: "security review" }),
    }),
    { params: Promise.resolve({ id: "connector-1" }) }
  )
}

describe("POST /api/integrations/connectors/[id]/disable", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.setStatus.mockResolvedValue({ id: "connector-1", status: "disabled" })
    mocks.auditCreate.mockResolvedValue({})
  })

  it("disables and audits a connector for a member with integration:manage", async () => {
    expect((await call()).status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "integration:manage")
    expect(mocks.setStatus).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      integrationId: "connector-1",
      status: "disabled",
      reason: "security review",
    })
    expect(mocks.auditCreate).toHaveBeenCalled()
  })

  it("does not disable a connector without integration:manage", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    expect((await call()).status).toBe(403)
    expect(mocks.setStatus).not.toHaveBeenCalled()
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })
})
