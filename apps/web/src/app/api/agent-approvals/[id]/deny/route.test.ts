import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ requirePermission: vi.fn(), denyApproval: vi.fn() }))

vi.mock("@lyrashield/db", () => ({
  ApprovalMutationError: class extends Error {},
  denyApproval: mocks.denyApproval,
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { agent: { approve: "agent:approve" } } }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))

import { POST } from "./route"

function call() {
  return POST(
    new Request("http://localhost/api/agent-approvals/approval-1/deny", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-1" }),
    }),
    { params: Promise.resolve({ id: "approval-1" }) }
  )
}

describe("POST /api/agent-approvals/[id]/deny", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.denyApproval.mockResolvedValue({ id: "approval-1", status: "DENIED" })
  })

  it("denies the approval for an authorised member", async () => {
    const response = await call()

    expect(response.status).toBe(200)
    expect(mocks.requirePermission).toHaveBeenCalledWith("workspace-1", "agent:approve")
    expect(mocks.denyApproval).toHaveBeenCalledWith("approval-1", "workspace-1", "user-1")
  })

  it("does not mutate an approval without agent:approve", async () => {
    mocks.requirePermission.mockRejectedValue(new Error("FORBIDDEN"))

    expect((await call()).status).toBe(403)
    expect(mocks.denyApproval).not.toHaveBeenCalled()
  })
})
