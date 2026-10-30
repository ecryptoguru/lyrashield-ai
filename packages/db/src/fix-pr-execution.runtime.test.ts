import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "./client"
import { beginFixPrExecution, getFixPrExecution } from "./fix-pr-execution-service"
import { createPullRequestRecord } from "./fix-proposal-service"

const provider = vi.hoisted(() => ({
  persistFailure: false,
  branch: vi.fn(),
  write: vi.fn(),
  pr: vi.fn(),
  inspect: vi.fn(),
}))
vi.mock("../../../apps/web/src/lib/fix-pr-connection", () => ({
  hasActiveFixPrConnection: vi.fn().mockResolvedValue(true),
}))
vi.mock("../../integrations/src/index", () => ({
  createBranch: provider.branch,
  createOrUpdateFile: provider.write,
  createPullRequest: provider.pr,
  inspectFixPrRemote: provider.inspect,
  getDefaultBranch: vi.fn().mockResolvedValue("main"),
  getBranchRefSha: vi.fn().mockResolvedValue("a".repeat(40)),
  getFileContent: vi.fn().mockResolvedValue("const insecure = true\n"),
}))
vi.mock("./index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index")>()
  return {
    ...actual,
    createPullRequestRecord: async (...args: Parameters<typeof actual.createPullRequestRecord>) => {
      if (provider.persistFailure) throw new Error("Injected database persistence failure")
      return actual.createPullRequestRecord(...args)
    },
  }
})
import { handleFixPrMergedAndReevaluate } from "./fix-pr-merge-service"
import { buildUnifiedDiff } from "../../fix/src/index"
import { buildFixPrApprovalInput, executeApprovedFixPr } from "../../../apps/web/src/lib/fix-pr"
import { hashInput } from "./agent-approval-service"

const suffix = randomUUID()
const workspaceId = `fix-ws-${suffix}`
const findingId = `fix-finding-${suffix}`
const proposalId = `fix-proposal-${suffix}`
beforeAll(async () => {
  await prisma.workspace.create({ data: { id: workspaceId, name: "Fix PR", slug: workspaceId } })
  await prisma.user.create({
    data: { id: `fix-user-${suffix}`, name: "Fix", email: `fix-${suffix}@example.invalid` },
  })
  await prisma.workspaceMember.create({
    data: { workspaceId, userId: `fix-user-${suffix}`, role: "OWNER", status: "active" },
  })
  await prisma.target.create({
    data: { id: `fix-target-${suffix}`, workspaceId, name: "Fix", type: "REPO" },
  })
  await prisma.scan.create({
    data: {
      id: `fix-scan-${suffix}`,
      workspaceId,
      targetId: `fix-target-${suffix}`,
      createdById: `fix-user-${suffix}`,
      goal: "TEST_APP",
      mode: "STANDARD",
      status: "COMPLETED",
    },
  })
  await prisma.finding.create({
    data: {
      id: findingId,
      workspaceId,
      scanId: `fix-scan-${suffix}`,
      targetId: `fix-target-${suffix}`,
      title: "Fix",
      summary: "Fix",
      severity: "LOW",
      dedupeKey: suffix,
    },
  })
  await prisma.fixProposal.create({ data: { id: proposalId, findingId, summary: "Patch" } })
})
afterAll(async () => {
  await prisma.workspace.delete({ where: { id: workspaceId } })
  await prisma.user.delete({ where: { id: `fix-user-${suffix}` } })
  await prisma.$disconnect()
})
describe("durable fix PR persistence", () => {
  it("persists one PR for concurrent repeated execution identities", async () => {
    const data = {
      provider: "github",
      repoOwner: "owner",
      repoName: "repo",
      branchName: "fix/same",
      prNumber: 42,
      prUrl: "https://github.com/owner/repo/pull/42",
      executionKey: suffix,
    }
    const records = await Promise.all([
      createPullRequestRecord(proposalId, workspaceId, data),
      createPullRequestRecord(proposalId, workspaceId, data),
    ])
    expect(records[0]?.id).toBe(records[1]?.id)
  })
  it("gives one concurrent actor the durable mutation intent", async () => {
    const params = {
      workspaceId,
      proposalId,
      executionKey: `race-${suffix}`,
      branchName: "fix/race",
      repoOwner: "owner",
      repoName: "repo",
      baseCommit: "base",
      diffChecksum: "checksum",
      approvalId: "approval-1",
      requestedById: "actor-1",
    }
    const [first, second] = await Promise.all([
      beginFixPrExecution(params),
      beginFixPrExecution({ ...params, requestedById: "actor-2", approvalId: "approval-2" }),
    ])
    expect(Number(first.created) + Number(second.created)).toBe(1)
    expect(first.record.id).toBe(second.record.id)
    expect(first.record.credentialActor).toEqual({
      kind: "browser",
      id: first.record.requestedById,
    })
    expect(
      await getFixPrExecution(`other-${workspaceId}`, proposalId, params.executionKey)
    ).toBeNull()
  })
  it("does not reopen a terminal row during stale concurrent recovery", async () => {
    const data = {
      provider: "github",
      repoOwner: "owner",
      repoName: "repo",
      branchName: "fix/terminal",
      prNumber: 43,
      prUrl: "https://github.com/owner/repo/pull/43",
      executionKey: `terminal-${suffix}`,
    }
    await createPullRequestRecord(proposalId, workspaceId, { ...data, status: "closed" })
    const row = await createPullRequestRecord(proposalId, workspaceId, { ...data, status: "open" })
    expect(row.status).toBe("closed")
  })
  it("composes approval claims and intent uniqueness across actual concurrent actors", async () => {
    const request = {
      workspaceId,
      targetId: `fix-target-${suffix}`,
      fixProposalId: proposalId,
      diff: buildUnifiedDiff("src/a.ts", "const insecure = true\n", "const insecure = false\n"),
      anchorFile: "src/a.ts",
      implicatedFiles: ["src/a.ts"],
      plan: "PRO",
      installationId: 1,
      repoOwner: "owner",
      repoName: "repo",
      baseCommit: "a".repeat(40),
      requestedById: `fix-user-${suffix}`,
    }
    const input = buildFixPrApprovalInput(request)
    const approvals = await Promise.all(
      ["first", "second"].map((actor) =>
        prisma.agentApproval.create({
          data: {
            id: `${actor}-${suffix}`,
            workspaceId,
            actionName: "fix_pr.open",
            inputHash: hashInput("fix_pr.open", input),
            input,
            status: "APPROVED",
            requestedById: actor,
            expiresAt: new Date(Date.now() + 60000),
          },
        })
      )
    )
    let entered!: () => void
    let release!: () => void
    const enteredBranch = new Promise<void>((resolve) => {
      entered = resolve
    })
    const releaseBranch = new Promise<void>((resolve) => {
      release = resolve
    })
    provider.branch.mockImplementationOnce(async () => {
      entered()
      await releaseBranch
    })
    provider.inspect.mockResolvedValue({ branchExists: false, pullRequest: null })
    provider.pr.mockResolvedValue({ number: 44, url: "https://github.com/owner/repo/pull/44" })
    const winner = executeApprovedFixPr({ ...request, approvalId: approvals[0]!.id })
    await Promise.race([
      enteredBranch,
      winner.then((outcome) => {
        throw new Error(`Execution stopped before branch: ${JSON.stringify(outcome)}`)
      }),
    ])
    try {
      const concurrent = await executeApprovedFixPr({
        ...request,
        requestedById: "another-actor",
        approvalId: approvals[1]!.id,
      })
      expect(concurrent.status).toBe("opening")
    } finally {
      release()
    }
    expect((await winner).status).toBe("opened")
    expect(provider.branch).toHaveBeenCalledOnce()
    expect(provider.write).toHaveBeenCalledOnce()
    expect(provider.pr).toHaveBeenCalledOnce()
    const rows = await prisma.pullRequest.findMany({
      where: { fixProposalId: proposalId, prNumber: 44 },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("open")
  })

  it("keeps legacy PR history from opening a second branch automatically", async () => {
    const legacyProposal = await prisma.fixProposal.create({
      data: { findingId, summary: "Legacy patch" },
    })
    await createPullRequestRecord(legacyProposal.id, workspaceId, {
      provider: "github",
      repoOwner: "owner",
      repoName: "repo",
      branchName: "fix/legacy",
      prNumber: 45,
    })
    const intent = await beginFixPrExecution({
      workspaceId,
      proposalId: legacyProposal.id,
      executionKey: `legacy-${suffix}`,
      branchName: "fix/new",
      repoOwner: "owner",
      repoName: "repo",
      baseCommit: "base",
      diffChecksum: "checksum",
      approvalId: "approval",
      requestedById: "actor",
    })
    expect(intent.created).toBe(false)
    expect(intent.record.branchName).toBe("fix/legacy")
  })
  it("recovers remote-open/local-persistence failure on a verified merge without duplicate scan", async () => {
    const proposal = await prisma.fixProposal.create({
      data: { findingId, summary: "Recover merged patch" },
    })
    const request = {
      workspaceId,
      targetId: `fix-target-${suffix}`,
      fixProposalId: proposal.id,
      diff: buildUnifiedDiff("src/a.ts", "const insecure = true\n", "const insecure = false\n"),
      anchorFile: "src/a.ts",
      implicatedFiles: ["src/a.ts"],
      plan: "PRO",
      installationId: 1,
      repoOwner: "owner",
      repoName: "repo",
      baseCommit: "a".repeat(40),
      requestedById: `fix-user-${suffix}`,
    }
    const input = buildFixPrApprovalInput(request)
    const approval = await prisma.agentApproval.create({
      data: {
        workspaceId,
        actionName: "fix_pr.open",
        inputHash: hashInput("fix_pr.open", input),
        input,
        status: "APPROVED",
        requestedById: request.requestedById,
        expiresAt: new Date(Date.now() + 60000),
      },
    })
    provider.branch.mockResolvedValue(undefined)
    provider.pr.mockResolvedValue({ number: 46, url: "https://github.com/owner/repo/pull/46" })
    const before = provider.pr.mock.calls.length
    provider.persistFailure = true
    try {
      expect((await executeApprovedFixPr({ ...request, approvalId: approval.id })).status).toBe(
        "recovery_required"
      )
    } finally {
      provider.persistFailure = false
    }
    const intent = await prisma.pullRequest.findFirstOrThrow({
      where: { fixProposalId: proposal.id },
    })
    expect(intent.status).toBe("recovery")
    expect(intent.prNumber).toBeNull()
    const options = {
      workspaceId,
      branchName: intent.branchName,
      prNumber: 46,
      repoFullName: "owner/repo",
      recoveryIdentity: {
        headRepoFullName: "owner/repo",
        body: `<!-- lyrashield-fix:${intent.executionKey} -->`,
      },
      assertRetestAllowed: async () => {},
      assertRetestWorkerAvailable: async () => {},
    }
    expect(
      await handleFixPrMergedAndReevaluate({ ...options, repoFullName: "other/repo" })
    ).toBeNull()
    expect(
      await handleFixPrMergedAndReevaluate({ ...options, workspaceId: `other-${workspaceId}` })
    ).toBeNull()
    expect(
      await handleFixPrMergedAndReevaluate({
        ...options,
        recoveryIdentity: { headRepoFullName: "fork/repo", body: options.recoveryIdentity.body },
      })
    ).toBeNull()
    expect(
      await handleFixPrMergedAndReevaluate({
        ...options,
        recoveryIdentity: { headRepoFullName: "owner/repo", body: "unrelated PR" },
      })
    ).toBeNull()
    expect(await handleFixPrMergedAndReevaluate({ ...options, prNumber: undefined })).toBeNull()
    await prisma.agentApproval.update({
      where: { id: approval.id },
      data: { inputHash: "tampered" },
    })
    expect(await handleFixPrMergedAndReevaluate(options)).toBeNull()
    await prisma.agentApproval.update({
      where: { id: approval.id },
      data: { inputHash: hashInput("fix_pr.open", input) },
    })
    await prisma.pullRequest.update({
      where: { id: intent.id },
      data: { diffChecksum: "tampered" },
    })
    expect(await handleFixPrMergedAndReevaluate(options)).toBeNull()
    await prisma.pullRequest.update({
      where: { id: intent.id },
      data: { diffChecksum: input.diffChecksum, prNumber: 47 },
    })
    expect(await handleFixPrMergedAndReevaluate(options)).toBeNull()
    await prisma.pullRequest.update({ where: { id: intent.id }, data: { prNumber: null } })
    const first = await handleFixPrMergedAndReevaluate(options)
    expect(first?.retestScanId).toBeTruthy()
    const replay = await handleFixPrMergedAndReevaluate(options)
    expect(replay?.retestScanId).toBe(first?.retestScanId)
    expect(await prisma.retest.count({ where: { workspaceId, findingId } })).toBe(1)
    expect(await prisma.scan.count({ where: { workspaceId, triggerType: "retest" } })).toBe(1)
    expect(provider.pr.mock.calls.length - before).toBe(1)
  })
})
