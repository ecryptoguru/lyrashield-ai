import { prisma } from "./client"
import type { FixProposal, PullRequest, Finding } from "./generated/prisma"
import { logger } from "@lyrashield/logger"

export interface CreateFixProposalParams {
  findingId: string
  workspaceId: string
  summary: string
  diffRef?: string
  generatedByModel?: string
  safetyScore?: number
}

export interface FixProposalWithDetails extends FixProposal {
  finding: Pick<Finding, "id" | "title" | "severity" | "status" | "cwe">
  pullRequests: PullRequest[]
}

export async function createFixProposal(params: CreateFixProposalParams): Promise<FixProposal> {
  const proposal = await prisma.fixProposal.create({
    data: {
      findingId: params.findingId,
      kind: "patch",
      summary: params.summary,
      ...(params.diffRef ? { diffRef: params.diffRef } : {}),
      ...(params.generatedByModel ? { generatedByModel: params.generatedByModel } : {}),
      ...(params.safetyScore != null ? { safetyScore: params.safetyScore } : {}),
      status: "draft",
    },
  })

  logger.info("Fix proposal created", {
    findingId: params.findingId,
    proposalId: proposal.id,
  })

  return proposal
}

export async function getFixProposal(
  proposalId: string,
  workspaceId: string
): Promise<FixProposalWithDetails | null> {
  const proposal = await prisma.fixProposal.findFirst({
    where: {
      id: proposalId,
      finding: { workspaceId, deletedAt: null },
      deletedAt: null,
    },
    include: {
      finding: {
        select: { id: true, title: true, severity: true, status: true, cwe: true },
      },
      pullRequests: true,
    },
  })

  return proposal as FixProposalWithDetails | null
}

export async function listFixProposals(params: {
  workspaceId: string
  findingId?: string
  status?: string
  cursor?: string
  limit?: number
}): Promise<{ items: FixProposalWithDetails[]; nextCursor: string | null }> {
  const limit = Math.min(params.limit ?? 20, 50)

  const proposals = await prisma.fixProposal.findMany({
    where: {
      deletedAt: null,
      finding: {
        workspaceId: params.workspaceId,
        deletedAt: null,
        ...(params.findingId ? { id: params.findingId } : {}),
      },
      ...(params.status ? { status: params.status } : {}),
    },
    include: {
      finding: {
        select: { id: true, title: true, severity: true, status: true, cwe: true },
      },
      pullRequests: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  })

  const nextCursor = proposals.length > limit ? proposals[limit]!.id : null
  const items = proposals.slice(0, limit) as FixProposalWithDetails[]

  return { items, nextCursor }
}

const VALID_PROPOSAL_STATUSES = [
  "draft",
  "approved",
  "rejected",
  "pr_opened",
  "pr_merged",
  "pr_closed",
] as const

export async function updateFixProposalStatus(
  proposalId: string,
  workspaceId: string,
  status: string
): Promise<FixProposal> {
  if (!VALID_PROPOSAL_STATUSES.includes(status as (typeof VALID_PROPOSAL_STATUSES)[number])) {
    throw new Error(`Invalid fix proposal status: ${status}`)
  }

  const proposal = await prisma.fixProposal.findFirst({
    where: {
      id: proposalId,
      finding: { workspaceId, deletedAt: null },
      deletedAt: null,
    },
  })

  if (!proposal) {
    throw new Error(`Fix proposal not found: ${proposalId}`)
  }

  return prisma.fixProposal.update({
    where: { id: proposalId },
    data: { status },
  })
}

export async function createPullRequestRecord(
  proposalId: string,
  data: {
    provider: string
    repoOwner: string
    repoName: string
    branchName: string
    prNumber?: number
    prUrl?: string
  }
): Promise<PullRequest> {
  const pr = await prisma.pullRequest.create({
    data: {
      fixProposalId: proposalId,
      provider: data.provider,
      repoOwner: data.repoOwner,
      repoName: data.repoName,
      branchName: data.branchName,
      ...(data.prNumber ? { prNumber: data.prNumber } : {}),
      ...(data.prUrl ? { prUrl: data.prUrl } : {}),
      status: "open",
    },
  })

  logger.info("Pull request record created", {
    proposalId,
    prId: pr.id,
    repo: `${data.repoOwner}/${data.repoName}`,
  })

  return pr
}
