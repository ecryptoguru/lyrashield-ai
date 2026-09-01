import { withWorkspaceRLS } from "./rls"
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
  return withWorkspaceRLS(params.workspaceId, async (tx) => {
    const finding = await tx.finding.findFirst({
      where: {
        id: params.findingId,
        workspaceId: params.workspaceId,
        deletedAt: null,
      },
    })
    if (!finding) {
      throw new Error(`Finding not found in workspace: ${params.findingId}`)
    }

    const proposal = await tx.fixProposal.create({
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
  })
}

export async function getFixProposal(
  proposalId: string,
  workspaceId: string
): Promise<FixProposalWithDetails | null> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const proposal = await tx.fixProposal.findFirst({
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
  })
}

export async function listFixProposals(params: {
  workspaceId: string
  findingId?: string
  status?: string
  cursor?: string
  limit?: number
}): Promise<{ items: FixProposalWithDetails[]; nextCursor: string | null }> {
  return withWorkspaceRLS(params.workspaceId, async (tx) => {
    const limit = Math.min(params.limit ?? 20, 50)

    const proposals = await tx.fixProposal.findMany({
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
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    })

    const hasMore = proposals.length > limit
    const items = (hasMore ? proposals.slice(0, limit) : proposals) as FixProposalWithDetails[]
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

    return { items, nextCursor }
  })
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

  return withWorkspaceRLS(workspaceId, async (tx) => {
    const proposal = await tx.fixProposal.findFirst({
      where: {
        id: proposalId,
        finding: { workspaceId, deletedAt: null },
        deletedAt: null,
      },
    })

    if (!proposal) {
      throw new Error(`Fix proposal not found: ${proposalId}`)
    }

    return tx.fixProposal.update({
      where: { id: proposalId },
      data: { status },
    })
  })
}

export async function createPullRequestRecord(
  proposalId: string,
  workspaceId: string,
  data: {
    provider: string
    repoOwner: string
    repoName: string
    branchName: string
    prNumber?: number
    prUrl?: string
  }
): Promise<PullRequest> {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const proposal = await tx.fixProposal.findFirst({
      where: {
        id: proposalId,
        finding: { workspaceId, deletedAt: null },
        deletedAt: null,
      },
    })
    if (!proposal) {
      throw new Error(`Fix proposal not found in workspace: ${proposalId}`)
    }

    const pr = await tx.pullRequest.create({
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
  })
}

export interface FixPrMergeResult {
  pullRequestId: string
  fixProposalId: string
  findingId: string
  retestId: string
}

/**
 * WP3 loop-closure: a LyraShield fix PR was merged in the customer's repo.
 * Marks the PR merged, queues a retest of the finding on the new head, and the
 * caller re-evaluates the gate so a merged fix moves the verdict toward READY.
 *
 * Returns null when no open PR matches the branch in this workspace — an
 * unknown or foreign branch is a no-op, never an error.
 */
export async function handleFixPrMerged(params: {
  workspaceId: string
  branchName: string
  prNumber?: number
  /** Scan to retest against (the finding's latest scan). */
  retestScanId: string
}): Promise<FixPrMergeResult | null> {
  return withWorkspaceRLS(params.workspaceId, async (tx) => {
    const pr = await tx.pullRequest.findFirst({
      where: {
        branchName: params.branchName,
        status: "open",
        deletedAt: null,
        fixProposal: { finding: { workspaceId: params.workspaceId, deletedAt: null } },
      },
      include: { fixProposal: { select: { id: true, findingId: true } } },
    })
    if (!pr) return null

    await tx.pullRequest.update({
      where: { id: pr.id },
      data: {
        status: "merged",
        mergedAt: new Date(),
        ...(params.prNumber ? { prNumber: params.prNumber } : {}),
      },
    })

    const retest = await tx.retest.create({
      data: {
        workspaceId: params.workspaceId,
        findingId: pr.fixProposal.findingId,
        scanId: params.retestScanId,
        status: "pending",
      },
    })

    logger.info("Fix PR merged — retest queued", {
      pullRequestId: pr.id,
      findingId: pr.fixProposal.findingId,
      retestId: retest.id,
    })

    return {
      pullRequestId: pr.id,
      fixProposalId: pr.fixProposal.id,
      findingId: pr.fixProposal.findingId,
      retestId: retest.id,
    }
  })
}
