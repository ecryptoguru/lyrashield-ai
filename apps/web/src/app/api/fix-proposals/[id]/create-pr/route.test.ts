import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const checksum = createHash("sha256").update("diff --git ...").digest("hex")
const generatedRef = `s3://bucket/evidence/workspace-1/finding-1/fix-patch/fix-proposal-1-${checksum}`

const requirePermission = vi.fn()
const hasActiveFixPrConnection = vi.fn()
const getFixProposal = vi.fn()
const readEncryptedArtifact = vi.fn()
const requestFixPrApproval = vi.fn()
const getFixPrStatus = vi.fn()
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
  toJsonObject: (value: object) => JSON.parse(JSON.stringify(value)),
}))
vi.mock("@lyrashield/evidence-storage", () => ({ readEncryptedArtifact }))
vi.mock("@lyrashield/logger", () => ({
  setRequestId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.test" } }))
vi.mock("@/lib/fix-pr-connection", () => ({ hasActiveFixPrConnection }))
vi.mock("@/lib/fix-pr", () => ({ requestFixPrApproval, getFixPrStatus }))

const { POST, GET } = await import("./route")

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
    hasActiveFixPrConnection.mockResolvedValue(true)
    failAgentOperation.mockResolvedValue({})
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
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
      diffRef: generatedRef,
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

  it("rejects a disabled GitHub connection before requesting an approval", async () => {
    getFixProposal.mockResolvedValue({
      id: "proposal-1",
      findingId: "finding-1",
      diffRef: generatedRef,
    })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: ["src/a.ts"],
      baseCommit: "abc123",
      target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
    })
    prisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" })
    hasActiveFixPrConnection.mockResolvedValue(false)
    const response = await call()
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "GITHUB_CONNECTION_INACTIVE" },
    })
    expect(requestFixPrApproval).not.toHaveBeenCalled()
    expect(readEncryptedArtifact).not.toHaveBeenCalled()
  })

  it.each([
    `s3://bucket/evidence/workspace-1/finding-1/fix-patch/fix-proposal-2-${checksum}`,
    `s3://bucket/evidence/workspace-1/finding-2/fix-patch/fix-proposal-1-${checksum}`,
    `s3://bucket/evidence/workspace-1/evidence-control-1/user-1/control-evidence/upload-1-${checksum}`,
    `s3://bucket/evidence/workspace-1/finding-1/code_location/code-loc-0-${checksum}`,
    `s3://bucket/evidence/workspace-1/finding-1/fix-patch/fix-proposal-1-${"0".repeat(64)}`,
    `s3://bucket/evidence/workspace-1/extra/evidence/workspace-1/finding-1/fix-patch/fix-proposal-1-${checksum}`,
    "s3://bucket/evidence/workspace-1/patch.diff",
  ])("rejects stored references without this proposal's producer binding: %s", async (diffRef) => {
    getFixProposal.mockResolvedValue({
      id: "proposal-1",
      findingId: "finding-1",
      diffRef,
      status: "approved",
    })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: ["src/a.ts"],
      baseCommit: "abc123",
      target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
    })
    prisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" })
    readEncryptedArtifact.mockResolvedValue({ content: Buffer.from("diff --git ..."), checksum })
    const response = await call()
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROPOSAL_PATCH_PROVENANCE_REQUIRED" },
    })
    expect(requestFixPrApproval).not.toHaveBeenCalled()
  })

  it("rejects when there is no base commit to patch against", async () => {
    getFixProposal.mockResolvedValue({
      id: "proposal-1",
      findingId: "finding-1",
      diffRef: generatedRef,
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
      diffRef: generatedRef,
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
        diffRef: generatedRef,
      })
      prisma.finding.findFirst.mockResolvedValue({
        id: "finding-1",
        targetId: "target-1",
        implicatedFiles: ["src/a.ts"],
        baseCommit: "abc123",
        target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
      })
      readEncryptedArtifact.mockResolvedValue({ content: Buffer.from("diff --git ..."), checksum })
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
      diffRef: generatedRef,
    })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: ["src/a.ts"],
      baseCommit: "abc123",
      target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
    })
    readEncryptedArtifact.mockResolvedValue({ content: Buffer.from("diff --git ..."), checksum })
    prisma.workspace.findUnique.mockResolvedValue({ plan: "STARTER" })
    requestFixPrApproval.mockResolvedValue({ status: "rejected", reason: "out of scope" })

    const response = await call()

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "PATCH_REJECTED" } })
  })

  it("replays a keyed approval request without creating another approval", async () => {
    getFixProposal.mockResolvedValue({
      id: "proposal-1",
      findingId: "finding-1",
      diffRef: generatedRef,
    })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      targetId: "target-1",
      implicatedFiles: ["src/a.ts"],
      baseCommit: "abc123",
      target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
    })
    readEncryptedArtifact.mockResolvedValue({ content: Buffer.from("diff --git ..."), checksum })
    requestFixPrApproval.mockResolvedValue({
      status: "pending_approval",
      approvalId: "approval-1",
      approvalUrl: "https://app.test/dashboard/approvals?approval=approval-1",
    })
    claimOrGetAgentOperation
      .mockResolvedValueOnce({ status: "NEW", operation: { id: "operation-1" } })
      .mockResolvedValueOnce({
        status: "REPLAY",
        operation: {
          id: "operation-1",
          result: {
            status: "pending_approval",
            approvalId: "approval-1",
            approvalUrl: "https://app.test/dashboard/approvals?approval=approval-1",
          },
        },
      })

    const first = await call({ workspaceId: "workspace-1" }, "fix-pr-once")
    const replay = await call({ workspaceId: "workspace-1" }, "fix-pr-once")

    expect(first.status).toBe(200)
    expect(await replay.json()).toEqual(await first.json())
    expect(requestFixPrApproval).toHaveBeenCalledOnce()
    expect(completeAgentOperation).toHaveBeenCalledOnce()
    expect(claimOrGetAgentOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        operationName: "fix.pr.request",
        input: expect.objectContaining({ proposalId: "proposal-1", baseCommit: "abc123" }),
      })
    )
  })
})

it("status uses the current actor and performs no approval or repository mutation", async () => {
  requirePermission.mockResolvedValue({ session: { userId: "reader-1" } })
  getFixProposal.mockResolvedValue({
    id: "proposal-1",
    findingId: "finding-1",
    diffRef: generatedRef,
  })
  prisma.finding.findFirst.mockResolvedValue({
    id: "finding-1",
    targetId: "target-1",
    implicatedFiles: ["src/a.ts"],
    baseCommit: "abc123",
    target: { repoOwner: "acme", repoName: "app", installationId: "42", deletedAt: null },
  })
  prisma.workspace.findUnique.mockResolvedValue({ plan: "PRO" })
  readEncryptedArtifact.mockResolvedValue({ content: Buffer.from("diff --git ..."), checksum })
  hasActiveFixPrConnection.mockResolvedValue(true)
  getFixPrStatus.mockResolvedValue({ status: "recovery_required" })
  requestFixPrApproval.mockClear()
  const response = await GET(
    new Request(
      "http://localhost/api/fix-proposals/proposal-1/create-pr?workspaceId=workspace-1&approvalId=approval-1"
    ),
    { params: Promise.resolve({ id: "proposal-1" }) }
  )
  expect(response.status).toBe(200)
  expect(getFixPrStatus).toHaveBeenCalledWith(
    expect.objectContaining({ requestedById: "reader-1", workspaceId: "workspace-1" }),
    "approval-1"
  )
  expect(requestFixPrApproval).not.toHaveBeenCalled()
})

it.each([
  { patch: "injected" },
  { branch: "injected" },
  { title: "injected" },
  { body: "injected" },
])("rejects extra PR execution fields %j", async (extra) => {
  requestFixPrApproval.mockClear()
  const response = await call({ workspaceId: "workspace-1", ...extra })
  expect(response.status).toBe(400)
  expect(requestFixPrApproval).not.toHaveBeenCalled()
})

it("rejects malformed JSON as a client error before resolving any proposal", async () => {
  getFixProposal.mockClear()
  const response = await POST(
    new Request("http://localhost/api/fix-proposals/proposal-1/create-pr", {
      method: "POST",
      body: "{",
    }),
    { params: Promise.resolve({ id: "proposal-1" }) }
  )
  expect(response.status).toBe(400)
  expect(getFixProposal).not.toHaveBeenCalled()
})
