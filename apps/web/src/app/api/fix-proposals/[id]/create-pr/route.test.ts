import { beforeEach, describe, expect, it, vi } from "vitest"

const requirePermission = vi.fn()
const getFixProposal = vi.fn()
const readEncryptedArtifact = vi.fn()
const requestFixPrApproval = vi.fn()
const claimOrGetAgentOperation = vi.fn()
const completeAgentOperation = vi.fn()
const failAgentOperation = vi.fn()

const prisma = {
  finding: { findFirst: vi.fn() },
  workspace: { findUnique: vi.fn() },
}

vi.mock("@lyrashield/auth/server", () => ({
  assertOAuthDelegatedScope: vi.fn(),
  requirePermission,
}))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { fix: { createPr: "fix:create_pr", approve: "fix:approve" } },
}))
vi.mock("@lyrashield/billing", () => ({
  resolveAccountBilling: vi.fn().mockResolvedValue({ effectivePlan: "PRO" }),
}))
vi.mock("@lyrashield/db", () => ({
  getFixProposal,
  prisma,
  claimOrGetAgentOperation,
  completeAgentOperation,
  failAgentOperation,
}))
vi.mock("@lyrashield/evidence-storage", () => ({ readEncryptedArtifact }))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.test" } }))
vi.mock("@/lib/fix-pr", () => ({ requestFixPrApproval }))

const { POST } = await import("./route")

function call(body: unknown = { workspaceId: "workspace-1" }, idempotencyKey?: string) {
  return POST(
    new Request("http://localhost/api/fix-proposals/proposal-1/create-pr", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "proposal-1" }) }
  )
}

describe("POST /api/fix-proposals/[id]/create-pr", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    failAgentOperation.mockResolvedValue({})
  })

  it.each([{ apiKey: { keyId: "key-1" } }, { oauth: { connectionId: "connection-1" } }])(
    "does not promote proposal permission into repository write authority",
    async (credential) => {
      requirePermission.mockImplementation(async (_workspaceId, permission) => {
        if (permission === "fix:approve") throw new Error("FORBIDDEN")
        return { session: { userId: "user-1", ...credential } }
      })
      expect((await call()).status).toBe(403)
      expect(getFixProposal).not.toHaveBeenCalled()
      expect(requestFixPrApproval).not.toHaveBeenCalled()
    }
  )

  it("fails closed when the proposal has no server-generated patch (diffRef)", async () => {
    getFixProposal.mockResolvedValue({ id: "proposal-1", findingId: "finding-1", diffRef: null })

    const response = await call()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROPOSAL_PATCH_REQUIRED" },
    })
    expect(requestFixPrApproval).not.toHaveBeenCalled()
    expect(readEncryptedArtifact).not.toHaveBeenCalled()
  })

  it("rejects when the finding's target is not linked to a GitHub repo", async () => {
    getFixProposal.mockResolvedValue({
      id: "proposal-1",
      findingId: "finding-1",
      diffRef: "s3://bucket/evidence/workspace-1/patch.diff",
    })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: ["src/a.ts"],
      baseCommit: "abc123",
      target: { repoOwner: null, repoName: null, installationId: null, deletedAt: null },
    })

    const response = await call()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NO_REPOSITORY_LINK" } })
    expect(requestFixPrApproval).not.toHaveBeenCalled()
  })

  it("rejects when there is no base commit to patch against", async () => {
    getFixProposal.mockResolvedValue({
      id: "proposal-1",
      findingId: "finding-1",
      diffRef: "s3://bucket/evidence/workspace-1/patch.diff",
    })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: ["src/a.ts"],
      baseCommit: null,
      target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
    })

    const response = await call()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NO_BASE_COMMIT" } })
  })

  it("rejects when there is no implicated file to scope the patch", async () => {
    getFixProposal.mockResolvedValue({
      id: "proposal-1",
      findingId: "finding-1",
      diffRef: "s3://bucket/evidence/workspace-1/patch.diff",
    })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: [],
      baseCommit: "abc123",
      target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
    })

    const response = await call()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NO_IMPLICATED_FILE" } })
  })

  it.each([
    { session: { userId: "user-1" }, authorization: undefined },
    {
      session: { userId: "user-1", apiKey: { keyId: "key-1" } },
      authorization: { kind: "api-key", id: "key-1" },
    },
    {
      session: { userId: "user-1", oauth: { connectionId: "connection-1" } },
      authorization: { kind: "oauth-connection", id: "connection-1" },
    },
  ])(
    "binds execution to the authenticated credential when everything resolves",
    async ({ session, authorization }) => {
      requirePermission.mockResolvedValue({ session })
      getFixProposal.mockResolvedValue({
        id: "proposal-1",
        findingId: "finding-1",
        diffRef: "s3://bucket/evidence/workspace-1/patch.diff",
      })
      prisma.finding.findFirst.mockResolvedValue({
        id: "finding-1",
        targetId: "target-1",
        implicatedFiles: ["src/a.ts"],
        baseCommit: "abc123",
        target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
      })
      readEncryptedArtifact.mockResolvedValue({ content: Buffer.from("diff --git ...") })
      prisma.workspace.findUnique.mockResolvedValue({ plan: "LAUNCH_ASSURANCE" })
      requestFixPrApproval.mockResolvedValue({ status: "pending_approval", approvalId: "ap-1" })

      const response = await call()

      expect(response.status).toBe(200)
      expect(requestFixPrApproval).toHaveBeenCalledOnce()
      const req = requestFixPrApproval.mock.calls[0]![0]
      expect(req.authorization).toEqual(authorization)
      if (authorization)
        expect(requirePermission).toHaveBeenCalledWith("workspace-1", "fix:approve")
      // The caller owns PRO; the workspace mirror must not upgrade the patch scope.
      expect(req.plan).toBe("PRO")
      expect(req.anchorFile).toBe("src/a.ts")
      expect(req.baseCommit).toBe("abc123")
      expect(req.installationId).toBe(42)
      expect(req.requestedById).toBe("user-1")
    }
  )

  it("surfaces a validator rejection as 422 without opening anything", async () => {
    getFixProposal.mockResolvedValue({
      id: "proposal-1",
      findingId: "finding-1",
      diffRef: "s3://bucket/evidence/workspace-1/patch.diff",
    })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: ["src/a.ts"],
      baseCommit: "abc123",
      target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
    })
    readEncryptedArtifact.mockResolvedValue({ content: Buffer.from("diff --git ...") })
    prisma.workspace.findUnique.mockResolvedValue({ plan: "STARTER" })
    requestFixPrApproval.mockResolvedValue({ status: "rejected", reason: "out of scope" })

    const response = await call()

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "PATCH_REJECTED" } })
  })

  it("replays an approved request by principal without opening another PR", async () => {
    getFixProposal.mockResolvedValue({
      id: "proposal-1",
      findingId: "finding-1",
      diffRef: "s3://bucket/evidence/workspace-1/patch.diff",
    })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: ["src/a.ts"],
      baseCommit: "abc123",
      target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
    })
    readEncryptedArtifact.mockResolvedValue({ content: Buffer.from("diff --git ...") })
    prisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" })
    requestFixPrApproval.mockResolvedValue({
      status: "pending_approval",
      approvalId: "ap-1",
      approvalUrl: "https://app.test/dashboard/approvals?approval=ap-1",
    })
    claimOrGetAgentOperation
      .mockResolvedValueOnce({ status: "NEW", operation: { id: "op-1" } })
      .mockResolvedValueOnce({
        status: "REPLAY",
        operation: {
          id: "op-1",
          result: {
            status: "pending_approval",
            approvalId: "ap-1",
            approvalUrl: "https://app.test/dashboard/approvals?approval=ap-1",
          },
        },
      })

    expect((await call(undefined, "retry-1")).status).toBe(200)
    const replay = await call(undefined, "retry-1")
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      data: {
        status: "pending_approval",
        approvalId: "ap-1",
        approvalUrl: "https://app.test/dashboard/approvals?approval=ap-1",
        operationId: "op-1",
      },
    })
    expect(requestFixPrApproval).toHaveBeenCalledOnce()
    expect(completeAgentOperation).toHaveBeenCalledWith("op-1", "workspace-1", {
      result: expect.objectContaining({ status: "pending_approval", approvalId: "ap-1" }),
      resultReference: "https://app.test/dashboard/approvals?approval=ap-1",
    })
    expect(claimOrGetAgentOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: "fix.pr.request",
        input: expect.objectContaining({
          proposalId: "proposal-1",
          targetId: "target-1",
          baseCommit: "abc123",
          diffChecksum: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      })
    )
  })

  it("records failed execution as failed, never a completed replay", async () => {
    getFixProposal.mockResolvedValue({
      id: "proposal-1",
      findingId: "finding-1",
      diffRef: "s3://bucket/evidence/workspace-1/patch.diff",
    })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: ["src/a.ts"],
      baseCommit: "abc123",
      target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
    })
    readEncryptedArtifact.mockResolvedValue({ content: Buffer.from("diff --git ...") })
    prisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" })
    requestFixPrApproval.mockResolvedValue({ status: "failed", reason: "provider detail" })
    claimOrGetAgentOperation
      .mockResolvedValueOnce({ status: "NEW", operation: { id: "op-2" } })
      .mockResolvedValueOnce({ status: "FAILED", operation: { id: "op-2" } })

    const failed = await call(undefined, "retry-2")
    expect(failed.status).toBe(502)
    const failedBody = await failed.json()
    expect(failedBody).toMatchObject({
      error: { code: "FIX_PR_FAILED", details: { operationId: "op-2" } },
    })
    expect(JSON.stringify(failedBody)).not.toContain("provider detail")
    expect(completeAgentOperation).not.toHaveBeenCalled()
    expect(failAgentOperation).toHaveBeenCalledWith("op-2", "workspace-1", {
      error: "OPERATION_OUTCOME_UNKNOWN",
    })
    const retry = await call(undefined, "retry-2")
    expect(retry.status).toBe(409)
    expect(requestFixPrApproval).toHaveBeenCalledOnce()
    expect(JSON.stringify(await retry.json())).not.toContain("provider detail")
  })
})
