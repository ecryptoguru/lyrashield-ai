import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
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
  begin: vi.fn(),
  existing: vi.fn(),
  remote: vi.fn(),
  recovery: vi.fn(),
  approval: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({
  claimApprovalExecution: mocks.claim,
  completeApprovalExecution: mocks.complete,
  failApprovalExecution: mocks.fail,
  createApproval: mocks.create,
  findPendingApprovalByHash: vi.fn(),
  findOrCreatePendingApproval: mocks.create,
  getFixProposal: mocks.proposal,
  getApproval: mocks.approval,
  hashInput: (action: string, input: unknown) => JSON.stringify({ action, input }),
  createPullRequestRecord: mocks.record,
  beginFixPrExecution: mocks.begin,
  getFixPrExecution: mocks.existing,
  markFixPrRecovery: mocks.recovery,
}))
vi.mock("./fix-pr-connection", () => ({ hasActiveFixPrConnection: mocks.connection }))
vi.mock("@lyrashield/integrations", () => ({
  createBranch: mocks.branch,
  createOrUpdateFile: mocks.write,
  createPullRequest: mocks.pr,
  inspectFixPrRemote: mocks.remote,
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
import {
  requestFixPrApproval,
  executeApprovedFixPr,
  getFixPrStatus,
  buildFixPrApprovalInput,
  type FixPrRequest,
} from "./fix-pr"
const request: FixPrRequest & { approvalId: string } = {
  workspaceId: "ws-1",
  targetId: "target-1",
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
    mocks.connection.mockResolvedValue(true)
    mocks.claim.mockResolvedValue(true)
    mocks.complete.mockResolvedValue(true)
    mocks.head.mockResolvedValue("scanned-sha")
    mocks.pr.mockResolvedValue({ number: 42, url: "https://github.com/owner/repo/pull/42" })
    mocks.branch.mockResolvedValue(undefined)
    mocks.begin.mockResolvedValue({ created: true, record: { id: "intent-1", status: "opening" } })
    mocks.existing.mockResolvedValue(null)
    mocks.remote.mockResolvedValue({ pullRequest: null, branchExists: false })
    mocks.record.mockImplementation(async (_proposal, _workspace, data) => ({
      status: data.status ?? "open",
    }))
    mocks.recovery.mockResolvedValue(undefined)
    mocks.fail.mockResolvedValue("TERMINAL")
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
  it("binds an existing-file update to the blob read at the scanned commit", async () => {
    expect((await executeApprovedFixPr(request)).status).toBe("opened")
    expect(mocks.write).toHaveBeenCalledWith(
      1,
      "owner",
      "repo",
      "src/app.ts",
      "patched",
      expect.any(String),
      expect.any(String),
      "489ce0f857e7634a0eb9f328265a3e91fad49f61"
    )
  })
  it("uses one deterministic branch across approval IDs and requesting principals", async () => {
    await executeApprovedFixPr(request)
    await executeApprovedFixPr({ ...request, approvalId: "approval-2", requestedById: "user-2" })
    expect(mocks.branch.mock.calls[0]?.[3]).toBe(mocks.branch.mock.calls[1]?.[3])
    expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.branch.mock.invocationCallOrder[0]!
    )
  })
  it("reconciles a remote success after a persistence failure without another write", async () => {
    mocks.record.mockRejectedValueOnce(new Error("database unavailable"))
    expect((await executeApprovedFixPr(request)).status).toBe("recovery_required")
    mocks.begin.mockResolvedValueOnce({
      created: false,
      record: { id: "intent-1", status: "recovery" },
    })
    mocks.remote.mockResolvedValueOnce({
      branchExists: true,
      pullRequest: { number: 42, url: "https://github.com/owner/repo/pull/42", status: "open" },
    })
    expect((await executeApprovedFixPr({ ...request, approvalId: "approval-2" })).status).toBe(
      "opened"
    )
    expect(mocks.branch).toHaveBeenCalledOnce()
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(mocks.pr).toHaveBeenCalledOnce()
  })
  it("never reopens a remotely closed PR", async () => {
    mocks.begin.mockResolvedValueOnce({
      created: false,
      record: { id: "intent-1", status: "recovery" },
    })
    mocks.remote.mockResolvedValueOnce({
      branchExists: true,
      pullRequest: { number: 42, url: "https://github.com/owner/repo/pull/42", status: "closed" },
    })
    expect((await executeApprovedFixPr(request)).status).toBe("closed")
    expect(mocks.branch).not.toHaveBeenCalled()
    expect(mocks.pr).not.toHaveBeenCalled()
  })
  it("keeps an uncertain partial branch in recovery without replaying writes", async () => {
    mocks.begin.mockResolvedValueOnce({
      created: false,
      record: { id: "intent-1", status: "recovery" },
    })
    mocks.remote.mockResolvedValueOnce({ branchExists: true, pullRequest: null })
    expect((await executeApprovedFixPr(request)).status).toBe("recovery_required")
    expect(mocks.branch).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.pr).not.toHaveBeenCalled()
  })
  it("refuses an approved patch after the GitHub connection is disabled", async () => {
    mocks.connection.mockResolvedValue(false)
    expect((await executeApprovedFixPr(request)).status).toBe("rejected")
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.branch).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.pr).not.toHaveBeenCalled()
  })
  it.each(["expired"])("does not touch the provider when claim refuses %s", async () => {
    mocks.claim.mockResolvedValue(false)
    expect((await executeApprovedFixPr(request)).status).toBe("failed")
    expect(mocks.branch).not.toHaveBeenCalled()
    expect(mocks.pr).not.toHaveBeenCalled()
  })
  it("cannot execute an approval twice", async () => {
    mocks.claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect((await executeApprovedFixPr(request)).status).toBe("opened")
    expect((await executeApprovedFixPr(request)).status).toBe("failed")
    expect(mocks.pr).toHaveBeenCalledOnce()
  })
  it("fails closed when repository HEAD changed since the scan", async () => {
    mocks.head.mockResolvedValue("new-sha")
    expect((await executeApprovedFixPr(request)).status).toBe("stale")
    expect(mocks.branch).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledOnce()
  })
  it("keeps unknown intent commit outcomes in recovery without an unowned failure update", async () => {
    mocks.begin.mockRejectedValueOnce(new Error("Intent commit outcome unknown"))
    expect((await executeApprovedFixPr(request)).status).toBe("recovery_required")
    expect(mocks.recovery).not.toHaveBeenCalled()
    expect(mocks.branch).not.toHaveBeenCalled()
  })
  it("records provider failure without retrying writes", async () => {
    mocks.branch.mockRejectedValue(new Error("provider unavailable"))
    expect((await executeApprovedFixPr(request)).status).toBe("recovery_required")
    expect(mocks.branch).toHaveBeenCalledOnce()
    expect(mocks.pr).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith(
      "approval-1",
      "ws-1",
      { error: "FIX_PR_RECOVERY_REQUIRED" },
      false
    )
    expect(mocks.complete).not.toHaveBeenCalled()
  })
})

describe("read-only Fix PR status", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.existing.mockResolvedValue(null)
  })
  it.each(["PENDING", "APPROVED", "EXPIRED"])(
    "reports expired %s without claiming approval",
    async (status) => {
      mocks.approval.mockResolvedValue({
        status,
        actionName: "fix_pr.open",
        inputHash: JSON.stringify({
          action: "fix_pr.open",
          input: buildFixPrApprovalInput(request),
        }),
        expiresAt: new Date(0),
      })
      expect(await getFixPrStatus(request, "approval-1")).toMatchObject({
        status: "expired",
        nextAction: "request_approval",
      })
      expect(mocks.claim).not.toHaveBeenCalled()
      expect(mocks.pr).not.toHaveBeenCalled()
    }
  )
  it("reports a mismatched approval as stale before execution", async () => {
    mocks.approval.mockResolvedValue({ actionName: "fix_pr.open", inputHash: "old" })
    expect((await getFixPrStatus(request, "approval-1")).status).toBe("stale")
    expect(mocks.claim).not.toHaveBeenCalled()
  })
  it.each([
    [
      "stale",
      "retest",
      "The repository changed since the scan. Retest and generate a new proposal.",
    ],
    [
      "failed",
      "regenerate_proposal",
      "Execution stopped before GitHub writes. Review the proposal and generate a new one.",
    ],
  ])(
    "keeps terminal %s execution guidance distinct from renewable approval",
    async (status, nextAction, reason) => {
      mocks.existing.mockResolvedValue({ status })
      mocks.proposal.mockResolvedValue({ id: request.fixProposalId })
      expect(await getFixPrStatus(request)).toMatchObject({ status, nextAction, reason })
      expect(await requestFixPrApproval(request, "https://app.test")).toMatchObject({
        status,
        nextAction,
        reason,
      })
      expect(mocks.create).not.toHaveBeenCalled()
    }
  )
  it("allows a fresh approval only for mismatched approval without an execution", async () => {
    mocks.proposal.mockResolvedValue({ id: request.fixProposalId })
    mocks.create.mockResolvedValue({ id: "fresh-approval" })
    mocks.approval.mockResolvedValue({ actionName: "fix_pr.open", inputHash: "old" })
    expect(await getFixPrStatus(request, "old-approval")).toMatchObject({
      status: "stale",
      nextAction: "request_approval",
    })
    expect(await requestFixPrApproval(request, "https://app.test")).toMatchObject({
      status: "pending_approval",
      approvalId: "fresh-approval",
    })
    expect(mocks.create).toHaveBeenCalledOnce()
  })
  it("keeps a stale base distinguishable from an infrastructure failure", async () => {
    mocks.existing.mockResolvedValue({ status: "stale" })
    expect((await getFixPrStatus(request)).status).toBe("stale")
    expect(mocks.remote).not.toHaveBeenCalled()
  })
  it("reconciles an existing intent without creating or claiming approval", async () => {
    mocks.existing.mockResolvedValue({ status: "recovery" })
    mocks.remote.mockResolvedValueOnce({
      branchExists: true,
      pullRequest: { number: 42, url: "https://github.com/owner/repo/pull/42", status: "open" },
    })
    expect((await getFixPrStatus(request)).status).toBe("opened")
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.branch).not.toHaveBeenCalled()
  })
})
