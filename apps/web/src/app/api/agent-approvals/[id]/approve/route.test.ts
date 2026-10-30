import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  get: vi.fn(),
  hash: vi.fn(),
  approve: vi.fn(),
  resolve: vi.fn(),
  execute: vi.fn(),
  input: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({
  ApprovalMutationError: class extends Error {},
  getApproval: mocks.get,
  verifyInputHash: mocks.hash,
  approveApproval: mocks.approve,
}))
vi.mock("@lyrashield/auth/server", () => ({ requirePermission: mocks.permission }))
vi.mock("@lyrashield/logger", () => ({ setRequestId: vi.fn(), logger: { error: vi.fn() } }))
vi.mock("@/lib/fix-pr-context", () => ({
  FixPrContextError: class extends Error {
    constructor(
      public code: string,
      message: string,
      public status = 409
    ) {
      super(message)
    }
  },
  resolveFixPrRequest: mocks.resolve,
}))
vi.mock("@/lib/fix-pr", () => ({
  executeApprovedFixPr: mocks.execute,
  buildFixPrApprovalInput: mocks.input,
}))
import { POST } from "./route"
import { PERMISSIONS } from "@lyrashield/auth"
import { FixPrContextError } from "@/lib/fix-pr-context"
const input = { fixProposalId: "stored-proposal", diffChecksum: "checksum" }
function call(extra = {}) {
  return POST(
    new Request("http://localhost/api/agent-approvals/approval-1/approve", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "ws-1", input, ...extra }),
    }),
    { params: Promise.resolve({ id: "approval-1" }) }
  )
}
describe("fix approval browser execution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.permission.mockResolvedValue({ session: { userId: "user-1" } })
    mocks.get.mockResolvedValue({ actionName: "fix_pr.open", input, inputHash: "hash" })
    mocks.hash.mockReturnValue(true)
    mocks.input.mockReturnValue({
      fixProposalId: "stored-proposal",
      diffChecksum: "current-checksum",
    })
    mocks.resolve.mockResolvedValue({ diff: "stored patch", workspaceId: "ws-1" })
    mocks.approve.mockResolvedValue({ id: "approval-1", status: "APPROVED" })
    mocks.execute.mockResolvedValue({ status: "opened", prNumber: 42 })
  })
  it("requires fix approval permission and resolves the stored proposal before execution", async () => {
    expect((await call()).status).toBe(200)
    expect(mocks.permission).toHaveBeenCalledWith("ws-1", PERMISSIONS.fix.approve)
    expect(mocks.resolve).toHaveBeenCalledWith("ws-1", "stored-proposal", "user-1")
    expect(mocks.execute).toHaveBeenCalledWith({
      diff: "stored patch",
      workspaceId: "ws-1",
      approvalId: "approval-1",
    })
  })
  it("refuses changed stored patch before recording approval", async () => {
    mocks.hash.mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect((await call()).status).toBe(422)
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it.each([
    { patch: "injected" },
    { branch: "injected" },
    { title: "injected" },
    { body: "injected" },
  ])("rejects extra approval fields %j", async (extra) => {
    expect((await call(extra)).status).toBe(400)
    expect(mocks.approve).not.toHaveBeenCalled()
  })
  it("does not execute a tampered input", async () => {
    mocks.hash.mockReturnValue(false)
    expect((await call()).status).toBe(422)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it("refuses a legacy pending approval whose stored patch lacks producer provenance", async () => {
    mocks.resolve.mockRejectedValueOnce(
      new FixPrContextError("PROPOSAL_PATCH_PROVENANCE_REQUIRED", "Patch provenance required")
    )
    const response = await call()
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROPOSAL_PATCH_PROVENANCE_REQUIRED" },
    })
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it("does not execute across workspace boundaries", async () => {
    mocks.get.mockResolvedValue(null)
    expect((await call()).status).toBe(404)
    expect(mocks.get).toHaveBeenCalledWith("approval-1", "ws-1")
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it("requires the separate fix permission", async () => {
    mocks.permission
      .mockResolvedValueOnce({ session: { userId: "user-1" } })
      .mockRejectedValueOnce(new Error("FORBIDDEN"))
    expect((await call()).status).toBe(403)
    expect(mocks.approve).not.toHaveBeenCalled()
  })
  it("reports execution failure truthfully", async () => {
    mocks.execute.mockResolvedValue({ status: "failed" })
    expect((await call()).status).toBe(409)
  })
})
