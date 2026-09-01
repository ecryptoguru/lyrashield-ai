import { beforeEach, describe, expect, it, vi } from "vitest"

const requirePermission = vi.fn()
const getFixProposal = vi.fn()
const readEncryptedArtifact = vi.fn()
const requestFixPrApproval = vi.fn()

const prisma = {
  finding: { findFirst: vi.fn() },
  workspace: { findUnique: vi.fn() },
}

vi.mock("@lyrashield/auth/server", () => ({ requirePermission }))
vi.mock("@lyrashield/auth", () => ({
  PERMISSIONS: { fix: { createPr: "fix:create_pr" } },
}))
vi.mock("@lyrashield/db", () => ({ getFixProposal, prisma }))
vi.mock("@lyrashield/evidence-storage", () => ({ readEncryptedArtifact }))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("@lyrashield/config", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.test" } }))
vi.mock("@/lib/fix-pr", () => ({ requestFixPrApproval }))

const { POST } = await import("./route")

function call(body: unknown = { workspaceId: "workspace-1" }) {
  return POST(
    new Request("http://localhost/api/fix-proposals/proposal-1/create-pr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "proposal-1" }) }
  )
}

describe("POST /api/fix-proposals/[id]/create-pr", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
  })

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

  it("requests approval with the validated patch when everything resolves", async () => {
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
    expect(req.plan).toBe("LAUNCH_ASSURANCE")
    expect(req.anchorFile).toBe("src/a.ts")
    expect(req.baseCommit).toBe("abc123")
    expect(req.installationId).toBe(42)
    expect(req.requestedById).toBe("user-1")
  })

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
})
