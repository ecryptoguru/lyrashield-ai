import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./client", () => ({
  prisma: {
    fixProposal: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    pullRequest: {
      create: vi.fn(),
    },
  },
}))

vi.mock("@lyrashield/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { prisma } from "./client"
import {
  createFixProposal,
  getFixProposal,
  listFixProposals,
  updateFixProposalStatus,
  createPullRequestRecord,
} from "./fix-proposal-service"

const mockPrisma = prisma as unknown as {
  fixProposal: {
    create: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  pullRequest: {
    create: ReturnType<typeof vi.fn>
  }
}

const baseProposal = {
  id: "prop-1",
  findingId: "finding-1",
  kind: "patch",
  summary: "Fix SQL injection by using parameterized queries",
  diffRef: null,
  status: "draft",
  safetyScore: null,
  generatedByModel: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe("fix-proposal-service", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("createFixProposal", () => {
    it("creates a fix proposal with required fields", async () => {
      mockPrisma.fixProposal.create.mockResolvedValue(baseProposal)

      const result = await createFixProposal({
        findingId: "finding-1",
        workspaceId: "ws-1",
        summary: "Fix SQL injection by using parameterized queries",
      })

      expect(result).toEqual(baseProposal)
      expect(mockPrisma.fixProposal.create).toHaveBeenCalledWith({
        data: {
          findingId: "finding-1",
          kind: "patch",
          summary: "Fix SQL injection by using parameterized queries",
          status: "draft",
        },
      })
    })

    it("creates a fix proposal with optional fields", async () => {
      mockPrisma.fixProposal.create.mockResolvedValue({
        ...baseProposal,
        diffRef: "encrypted://diffs/prop-1",
        safetyScore: 85,
        generatedByModel: "gpt-4o",
      })

      await createFixProposal({
        findingId: "finding-1",
        workspaceId: "ws-1",
        summary: "Fix XSS by adding output encoding",
        diffRef: "encrypted://diffs/prop-1",
        safetyScore: 85,
        generatedByModel: "gpt-4o",
      })

      expect(mockPrisma.fixProposal.create).toHaveBeenCalledWith({
        data: {
          findingId: "finding-1",
          kind: "patch",
          summary: "Fix XSS by adding output encoding",
          diffRef: "encrypted://diffs/prop-1",
          safetyScore: 85,
          generatedByModel: "gpt-4o",
          status: "draft",
        },
      })
    })
  })

  describe("getFixProposal", () => {
    it("returns proposal with finding and PRs", async () => {
      const proposalWithDetails = {
        ...baseProposal,
        finding: {
          id: "finding-1",
          title: "SQL Injection",
          severity: "CRITICAL",
          status: "OPEN",
          cwe: "CWE-89",
        },
        pullRequests: [],
      }
      mockPrisma.fixProposal.findFirst.mockResolvedValue(proposalWithDetails)

      const result = await getFixProposal("prop-1", "ws-1")

      expect(result).toEqual(proposalWithDetails)
      expect(mockPrisma.fixProposal.findFirst).toHaveBeenCalledWith({
        where: {
          id: "prop-1",
          finding: { workspaceId: "ws-1", deletedAt: null },
          deletedAt: null,
        },
        include: {
          finding: { select: { id: true, title: true, severity: true, status: true, cwe: true } },
          pullRequests: true,
        },
      })
    })

    it("returns null when proposal not found", async () => {
      mockPrisma.fixProposal.findFirst.mockResolvedValue(null)

      const result = await getFixProposal("nonexistent", "ws-1")

      expect(result).toBeNull()
    })
  })

  describe("listFixProposals", () => {
    it("lists proposals with default limit", async () => {
      mockPrisma.fixProposal.findMany.mockResolvedValue([baseProposal])

      const result = await listFixProposals({ workspaceId: "ws-1" })

      expect(result.items).toHaveLength(1)
      expect(result.nextCursor).toBeNull()
      expect(mockPrisma.fixProposal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            finding: { workspaceId: "ws-1", deletedAt: null },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 21,
        })
      )
    })

    it("returns nextCursor when more results exist", async () => {
      const proposals = Array.from({ length: 21 }, (_, i) => ({
        ...baseProposal,
        id: `prop-${i}`,
      }))
      mockPrisma.fixProposal.findMany.mockResolvedValue(proposals)

      const result = await listFixProposals({ workspaceId: "ws-1", limit: 20 })

      expect(result.items).toHaveLength(20)
      expect(result.nextCursor).toBe("prop-19")
    })

    it("filters by findingId and status", async () => {
      mockPrisma.fixProposal.findMany.mockResolvedValue([])

      await listFixProposals({ workspaceId: "ws-1", findingId: "finding-1", status: "draft" })

      expect(mockPrisma.fixProposal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
            finding: expect.objectContaining({
              workspaceId: "ws-1",
              deletedAt: null,
              id: "finding-1",
            }),
            status: "draft",
          }),
        })
      )
    })
  })

  describe("updateFixProposalStatus", () => {
    it("updates status when proposal exists", async () => {
      mockPrisma.fixProposal.findFirst.mockResolvedValue(baseProposal)
      mockPrisma.fixProposal.update.mockResolvedValue({ ...baseProposal, status: "approved" })

      const result = await updateFixProposalStatus("prop-1", "ws-1", "approved")

      expect(result.status).toBe("approved")
      expect(mockPrisma.fixProposal.update).toHaveBeenCalledWith({
        where: { id: "prop-1" },
        data: { status: "approved" },
      })
    })

    it("throws when proposal not found", async () => {
      mockPrisma.fixProposal.findFirst.mockResolvedValue(null)

      await expect(updateFixProposalStatus("nonexistent", "ws-1", "approved")).rejects.toThrow(
        "Fix proposal not found: nonexistent"
      )
    })

    it("throws on invalid status value", async () => {
      await expect(updateFixProposalStatus("prop-1", "ws-1", "hacked")).rejects.toThrow(
        "Invalid fix proposal status: hacked"
      )
      expect(mockPrisma.fixProposal.findFirst).not.toHaveBeenCalled()
    })
  })

  describe("createPullRequestRecord", () => {
    it("creates a PR record with all fields", async () => {
      const prRecord = {
        id: "pr-1",
        fixProposalId: "prop-1",
        provider: "github",
        repoOwner: "owner",
        repoName: "repo",
        branchName: "fix-branch",
        prNumber: 42,
        prUrl: "https://github.com/owner/repo/pull/42",
        status: "open",
      }
      mockPrisma.pullRequest.create.mockResolvedValue(prRecord)

      const result = await createPullRequestRecord("prop-1", {
        provider: "github",
        repoOwner: "owner",
        repoName: "repo",
        branchName: "fix-branch",
        prNumber: 42,
        prUrl: "https://github.com/owner/repo/pull/42",
      })

      expect(result).toEqual(prRecord)
      expect(mockPrisma.pullRequest.create).toHaveBeenCalledWith({
        data: {
          fixProposalId: "prop-1",
          provider: "github",
          repoOwner: "owner",
          repoName: "repo",
          branchName: "fix-branch",
          prNumber: 42,
          prUrl: "https://github.com/owner/repo/pull/42",
          status: "open",
        },
      })
    })

    it("creates a PR record without optional fields", async () => {
      mockPrisma.pullRequest.create.mockResolvedValue({
        id: "pr-2",
        fixProposalId: "prop-1",
        provider: "github",
        repoOwner: "owner",
        repoName: "repo",
        branchName: "fix-branch",
        prNumber: null,
        prUrl: null,
        status: "open",
      })

      await createPullRequestRecord("prop-1", {
        provider: "github",
        repoOwner: "owner",
        repoName: "repo",
        branchName: "fix-branch",
      })

      expect(mockPrisma.pullRequest.create).toHaveBeenCalledWith({
        data: {
          fixProposalId: "prop-1",
          provider: "github",
          repoOwner: "owner",
          repoName: "repo",
          branchName: "fix-branch",
          status: "open",
        },
      })
    })
  })
})
