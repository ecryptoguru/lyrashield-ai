import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildComposerUpdateDiff, diffChecksum } from "@lyrashield/fix"

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  create: vi.fn(),
  branch: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  pr: vi.fn(),
  fail: vi.fn(),
}))
vi.mock("@lyrashield/db", () => ({
  claimApprovalExecution: mocks.claim,
  completeApprovalExecution: vi.fn(),
  createApproval: mocks.create,
  failApprovalExecution: mocks.fail,
  findPendingApprovalByHash: vi.fn(),
  getFixProposal: vi.fn().mockResolvedValue({ id: "proposal-1" }),
  hashInput: (_action: string, input: unknown) => JSON.stringify(input),
  createPullRequestRecord: vi.fn(),
}))
vi.mock("@lyrashield/integrations", () => ({
  createBranch: mocks.branch,
  createOrUpdateFile: mocks.write,
  createPullRequest: mocks.pr,
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
  getBranchRefSha: vi.fn().mockResolvedValue("a".repeat(40)),
  getFileContent: mocks.read,
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { requestFixPrApproval, executeApprovedFixPr, type FixPrRequest } from "./fix-pr"

const before =
  JSON.stringify(
    {
      "content-hash": "a".repeat(32),
      packages: [{ name: "psr/log", version: "1.1.3" }],
      "packages-dev": [],
    },
    null,
    4
  ) + "\n"
const after = before.replace("1.1.3", "1.1.4")
function request() {
  const diff = buildComposerUpdateDiff("composer.lock", before, after)
  const artifact = {
    version: "composer-fix/1" as const,
    workspaceId: "ws-1",
    targetId: "target-1",
    findingId: "finding-1",
    proposalId: "proposal-1",
    baseCommit: "a".repeat(40),
    manifestPath: "composer.json",
    lockPath: "composer.lock",
    packageName: "psr/log",
    fromVersion: "1.1.3",
    toVersion: "1.1.4",
    before,
    after,
    diff,
    diffChecksum: diffChecksum(diff),
    resolverImage: "composer@sha256:" + "b".repeat(64),
    checks: {
      network: "none" as const,
      scripts: false as const,
      plugins: false as const,
      install: false as const,
      lockValidated: true as const,
    },
    compatibility: "customer-tests-required" as const,
  }
  return {
    workspaceId: "ws-1",
    targetId: "target-1",
    fixProposalId: "proposal-1",
    findingId: "finding-1",
    diff,
    anchorFile: "composer.lock",
    implicatedFiles: ["composer.lock"],
    plan: "PRO",
    installationId: 1,
    repoOwner: "owner",
    repoName: "repo",
    baseCommit: "a".repeat(40),
    requestedById: "user-1",
    approvalId: "approval-1",
    composerFix: artifact,
  } satisfies FixPrRequest & { approvalId: string }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.claim.mockResolvedValue(true)
  mocks.read.mockResolvedValue(before)
  mocks.pr.mockResolvedValue({ number: 1, url: "https://github.com/owner/repo/pull/1" })
  mocks.create.mockResolvedValue({ id: "approval-1" })
})
describe("approval-bound Composer updates", () => {
  it("binds the resolver receipt as well as patch bytes into approval", async () => {
    const result = await requestFixPrApproval(request(), "https://app.test")
    expect(result.status).toBe("pending_approval")
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          composerReceiptChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      })
    )
  })
  it("applies the exact regenerated lock and explains compatibility review", async () => {
    expect((await executeApprovedFixPr(request())).status).toBe("opened")
    expect(mocks.write).toHaveBeenCalledWith(
      1,
      "owner",
      "repo",
      "composer.lock",
      after,
      expect.any(String),
      expect.any(String)
    )
    expect(mocks.pr).toHaveBeenCalledWith(
      1,
      "owner",
      "repo",
      expect.any(String),
      expect.stringContaining("application compatibility tests"),
      expect.any(String),
      "main"
    )
  })
  it("refuses changed base bytes before opening a provider branch", async () => {
    mocks.read.mockResolvedValue(before + " ")
    expect((await executeApprovedFixPr(request())).status).toBe("failed")
    expect(mocks.branch).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })
  it("rejects swapped receipt scope and patch without claiming approval", async () => {
    const req = request()
    req.composerFix.targetId = "another-target"
    expect((await executeApprovedFixPr(req)).status).toBe("rejected")
    expect(mocks.claim).not.toHaveBeenCalled()
  })
})
