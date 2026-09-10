import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  proposal: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  branch: vi.fn(),
  write: vi.fn(),
  pr: vi.fn(),
  head: vi.fn(),
  record: vi.fn(),
  validate: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({
  claimApprovalExecution: mocks.claim,
  completeApprovalExecution: mocks.complete,
  failApprovalExecution: mocks.fail,
  createApproval: mocks.create,
  findPendingApprovalByHash: vi.fn(),
  getFixProposal: mocks.proposal,
  hashInput: (action: string, input: unknown) => JSON.stringify({ action, input }),
  createPullRequestRecord: mocks.record,
}))
vi.mock("@lyrashield/integrations", () => ({
  createBranch: mocks.branch,
  createOrUpdateFile: mocks.write,
  createPullRequest: mocks.pr,
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
  getBranchRefSha: mocks.head,
  getFileContent: vi.fn().mockResolvedValue("old"),
}))
vi.mock("@lyrashield/fix", () => ({
  validatePatchDiff: mocks.validate,
  diffChecksum: (diff: string) => `checksum:${diff}`,
  patchScopeForPlan: vi.fn(),
  applyUnifiedDiff: vi.fn().mockReturnValue("patched"),
  extractFileDiff: vi.fn(),
}))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn() },
}))
import { requestFixPrApproval, executeApprovedFixPr, type FixPrRequest } from "./fix-pr"
const request: FixPrRequest & { approvalId: string } = {
  workspaceId: "ws-1",
  fixProposalId: "proposal-1",
  diff: "stored patch",
  anchorFile: "src/app.ts",
  implicatedFiles: ["src/app.ts"],
  plan: "PRO",
  installationId: 1,
  repoOwner: "owner",
  repoName: "repo",
  baseCommit: "scanned-sha",
  requestedById: "user-1",
  approvalId: "approval-1",
}
describe("approved fix PR execution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.validate.mockReturnValue({ ok: true, filesTouched: ["src/app.ts"] })
    mocks.claim.mockResolvedValue(true)
    mocks.head.mockResolvedValue("scanned-sha")
    mocks.pr.mockResolvedValue({ number: 42, url: "https://github.com/owner/repo/pull/42" })
    mocks.branch.mockResolvedValue(undefined)
  })
  it("executes credential-authorized patches through the same atomic hash claim", async () => {
    mocks.proposal.mockResolvedValue({ id: "proposal-1" })
    mocks.create.mockResolvedValue({ id: "receipt-1", status: "APPROVED" })
    const authorization = { kind: "oauth-connection" as const, id: "connection-1" }
    expect(
      (await requestFixPrApproval({ ...request, authorization }, "https://app.test")).status
    ).toBe("opened")
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ authorization }))
    expect(mocks.claim).toHaveBeenCalledWith("receipt-1", "ws-1", expect.any(String))
  })
  it("claims the exact stored patch and workspace before any provider write", async () => {
    expect((await executeApprovedFixPr(request)).status).toBe("opened")
    expect(mocks.claim).toHaveBeenCalledWith(
      "approval-1",
      "ws-1",
      expect.stringContaining("checksum:stored patch")
    )
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.branch.mock.invocationCallOrder[0]!
    )
    expect(mocks.complete).toHaveBeenCalledWith("approval-1", "ws-1", {
      prNumber: 42,
      prUrl: "https://github.com/owner/repo/pull/42",
    })
  })
  it.each(["expired", "denied", "wrong workspace", "hash mismatch"])(
    "does not touch the provider when claim refuses %s",
    async () => {
      mocks.claim.mockResolvedValue(false)
      expect((await executeApprovedFixPr(request)).status).toBe("failed")
      expect(mocks.branch).not.toHaveBeenCalled()
      expect(mocks.pr).not.toHaveBeenCalled()
    }
  )
  it("cannot execute an approval twice", async () => {
    mocks.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect((await executeApprovedFixPr(request)).status).toBe("opened")
    expect((await executeApprovedFixPr(request)).status).toBe("failed")
    expect(mocks.pr).toHaveBeenCalledOnce()
  })
  it("fails closed when repository HEAD changed since the scan", async () => {
    mocks.head.mockResolvedValue("new-sha")
    expect((await executeApprovedFixPr(request)).status).toBe("failed")
    expect(mocks.branch).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledOnce()
  })
  it("records provider failure without retrying writes", async () => {
    mocks.branch.mockRejectedValue(new Error("provider unavailable"))
    expect((await executeApprovedFixPr(request)).status).toBe("failed")
    expect(mocks.branch).toHaveBeenCalledOnce()
    expect(mocks.pr).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith(
      "approval-1",
      "ws-1",
      { error: "provider unavailable" },
      false
    )
    expect(mocks.complete).not.toHaveBeenCalled()
  })
})
