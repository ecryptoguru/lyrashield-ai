import { beforeEach, describe, expect, it, vi } from "vitest"

const requirePermission = vi.fn()
const getFixProposal = vi.fn()
const createAndSendNotification = vi.fn()
const getDefaultBranch = vi.fn()
const getBranchRefSha = vi.fn()
const createBranch = vi.fn()
const createOrUpdateFile = vi.fn()
const createPullRequest = vi.fn()

const prisma = {
  finding: { findFirst: vi.fn() },
  integration: { findFirst: vi.fn() },
  workspace: { findFirst: vi.fn() },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@lyrashield/auth/server", () => ({ requirePermission }))
vi.mock("@lyrashield/auth", () => ({ PERMISSIONS: { fix: { createPr: "fix.createPr" } } }))
vi.mock("@lyrashield/db", () => ({ getFixProposal, createAndSendNotification, prisma }))
vi.mock("@lyrashield/integrations", () => ({
  getDefaultBranch,
  getBranchRefSha,
  createBranch,
  createOrUpdateFile,
  createPullRequest,
  sendNotification: vi.fn(),
}))
vi.mock("@lyrashield/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { POST } = await import("./route")

describe("POST /api/fix-proposals/[id]/create-pr", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePermission.mockResolvedValue({ session: { userId: "user-1" } })
    getFixProposal.mockResolvedValue({ id: "proposal-1", findingId: "finding-1" })
    prisma.finding.findFirst.mockResolvedValue({
      id: "finding-1",
      title: "SQL injection",
      target: { repoOwner: "acme", repoName: "app", branch: "main" },
    })
    prisma.integration.findFirst.mockResolvedValue({ externalId: "42" })
    getBranchRefSha.mockResolvedValue("sha-1")
    createPullRequest.mockResolvedValue({ number: 7, url: "https://github.com/acme/app/pull/7" })
    prisma.$transaction.mockImplementation(async (fn) =>
      fn({
        pullRequest: { create: vi.fn().mockResolvedValue({ id: "pr-1" }) },
        fixProposal: { update: vi.fn() },
        finding: { update: vi.fn() },
      })
    )
    prisma.workspace.findFirst.mockResolvedValue({ name: "Acme" })
  })

  it("fails closed when the proposal has no server-generated approved patch", async () => {
    const response = await POST(
      new Request("http://localhost/api/fix-proposals/proposal-1/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
        }),
      }),
      { params: Promise.resolve({ id: "proposal-1" }) }
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROPOSAL_PATCH_REQUIRED" },
    })
    expect(createBranch).not.toHaveBeenCalled()
    expect(createPullRequest).not.toHaveBeenCalled()
    expect(createAndSendNotification).not.toHaveBeenCalled()
  })
})
