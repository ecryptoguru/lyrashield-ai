/**
 * WP3 fix-PR execution orchestrator.
 *
 * Turns a validated FixProposal into an approval-bound GitHub pull request.
 * The approval binding is the security boundary: the exact diff is hashed into
 * the AgentApproval inputHash, and claimApprovalExecution enforces hash +
 * expiry + single-executor inside its claim predicate. A tampered diff changes
 * the hash and can never be claimed; an unapproved diff never executes.
 *
 * There is deliberately NO merge path. We push a branch and open a PR; the
 * customer merges or closes it. "Nothing auto-merges" is a published promise
 * and is structurally true here — this module has no merge call.
 */

import {
  claimApprovalExecution,
  completeApprovalExecution,
  createApproval,
  failApprovalExecution,
  findPendingApprovalByHash,
  getFixProposal,
  hashInput,
  createPullRequestRecord,
} from "@lyrashield/db"
import {
  createBranch,
  createOrUpdateFile,
  createPullRequest,
  getDefaultBranch,
  getBranchRefSha,
  getFileContent,
} from "@lyrashield/integrations"
import {
  validatePatchDiff,
  diffChecksum,
  patchScopeForPlan,
  applyUnifiedDiff,
  extractFileDiff,
} from "@lyrashield/fix"
import { logger } from "@lyrashield/logger"

const APPROVAL_ACTION = "fix_pr.open"
const APPROVAL_TTL_MINUTES = 15

export interface FixPrRequest {
  workspaceId: string
  fixProposalId: string
  /** The unified diff to apply. Hashed into the approval. */
  diff: string
  /** The single file the finding is anchored to. */
  anchorFile: string
  /** The finding's implicated file set. */
  implicatedFiles: string[]
  /** Workspace plan (WorkspacePlan enum value) — drives the scope tier. */
  plan: string
  /** GitHub target. */
  installationId: number
  repoOwner: string
  repoName: string
  /** The commit the scan ran on (the diff must apply against it). */
  baseCommit: string
  /** The user requesting execution. */
  requestedById: string
}

export interface FixPrOutcome {
  status: "pending_approval" | "opened" | "rejected" | "failed"
  approvalId?: string
  approvalUrl?: string
  prNumber?: number
  prUrl?: string
  reason?: string
}

function approvalUrl(base: string, approvalId: string): string {
  return `${base.replace(/\/+$/, "")}/agent-approvals/${approvalId}`
}

/**
 * Request approval for a fix PR. Validates the diff against the plan's scope
 * policy FIRST (an invalid diff never reaches a human), then creates (or
 * reuses) a pending AgentApproval bound to the exact diff hash.
 */
export async function requestFixPrApproval(
  req: FixPrRequest,
  appUrl: string
): Promise<FixPrOutcome> {
  const proposal = await getFixProposal(req.fixProposalId, req.workspaceId)
  if (!proposal) return { status: "rejected", reason: "Fix proposal not found." }

  // Validate the diff against the plan-tiered scope policy before any approval
  // exists — an unsound or out-of-scope patch must never be presented as viable.
  const policy = patchScopeForPlan(req.plan)
  const validation = validatePatchDiff(req.diff, req.anchorFile, req.implicatedFiles, policy)
  if (!validation.ok) {
    logger.warn("Fix PR diff rejected by validator", {
      fixProposalId: req.fixProposalId,
      code: validation.code,
    })
    return { status: "rejected", reason: validation.reason }
  }

  const checksum = diffChecksum(req.diff)
  const input = {
    actionName: APPROVAL_ACTION,
    fixProposalId: req.fixProposalId,
    diffChecksum: checksum,
    baseCommit: req.baseCommit,
    targetRepo: `${req.repoOwner}/${req.repoName}`,
  }
  const inputHash = hashInput(APPROVAL_ACTION, input)

  const existing = await findPendingApprovalByHash(req.workspaceId, APPROVAL_ACTION, inputHash)
  const approval =
    existing ??
    (await createApproval({
      workspaceId: req.workspaceId,
      actionName: APPROVAL_ACTION,
      input,
      requestedById: req.requestedById,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MINUTES * 60 * 1000),
    }))

  return {
    status: "pending_approval",
    approvalId: approval.id,
    approvalUrl: approvalUrl(appUrl, approval.id),
  }
}

/**
 * Execute an approved fix PR. Called after the human approves. Claims the
 * approval atomically (hash + expiry + single-winner), pushes the branch,
 * applies the diff file-by-file, and opens the PR. Never merges.
 */
export async function executeApprovedFixPr(
  req: FixPrRequest & { approvalId: string }
): Promise<FixPrOutcome> {
  const checksum = diffChecksum(req.diff)
  const input = {
    actionName: APPROVAL_ACTION,
    fixProposalId: req.fixProposalId,
    diffChecksum: checksum,
    baseCommit: req.baseCommit,
    targetRepo: `${req.repoOwner}/${req.repoName}`,
  }
  const inputHash = hashInput(APPROVAL_ACTION, input)

  // Re-validate at execution time: the approval binds to this exact hash, but
  // defense-in-depth says re-check the diff against scope before any write.
  const policy = patchScopeForPlan(req.plan)
  const validation = validatePatchDiff(req.diff, req.anchorFile, req.implicatedFiles, policy)
  if (!validation.ok) {
    return { status: "rejected", reason: validation.reason }
  }

  const claimed = await claimApprovalExecution(req.approvalId, req.workspaceId, inputHash)
  if (!claimed) {
    return {
      status: "failed",
      reason: "Approval is missing, expired, already executed, or does not match this patch.",
    }
  }

  const branchName = `lyrashield/fix-${req.fixProposalId.slice(0, 12)}`
  try {
    const baseBranch = await getDefaultBranch(req.installationId, req.repoOwner, req.repoName)
    const fromSha = await getBranchRefSha(
      req.installationId,
      req.repoOwner,
      req.repoName,
      baseBranch
    )
    await createBranch(req.installationId, req.repoOwner, req.repoName, branchName, fromSha)

    // Apply the validated diff file-by-file: fetch current content at the base
    // commit, apply the unified diff (fail-closed on any hunk mismatch), write
    // the result to the fix branch. A file with no readable content is a hard
    // failure — we never write a partial patch.
    for (const file of validation.filesTouched) {
      const current = await getFileContent(
        req.installationId,
        req.repoOwner,
        req.repoName,
        file,
        fromSha
      )
      if (current === null) {
        throw new Error(
          `Cannot read ${file} at the scanned commit — patch cannot be applied safely.`
        )
      }
      const newContent = applyUnifiedDiff(current, extractFileDiff(req.diff, file))
      await createOrUpdateFile(
        req.installationId,
        req.repoOwner,
        req.repoName,
        file,
        newContent,
        `fix: ${req.fixProposalId}`,
        branchName
      )
    }

    const pr = await createPullRequest(
      req.installationId,
      req.repoOwner,
      req.repoName,
      `LyraShield fix proposal ${req.fixProposalId.slice(0, 8)}`,
      prBody(req, checksum),
      branchName,
      baseBranch
    )

    await createPullRequestRecord(req.fixProposalId, req.workspaceId, {
      provider: "github",
      repoOwner: req.repoOwner,
      repoName: req.repoName,
      branchName,
      prNumber: pr.number,
      prUrl: pr.url,
    })

    await completeApprovalExecution(req.approvalId, req.workspaceId, {
      prNumber: pr.number,
      prUrl: pr.url,
    })

    return { status: "opened", approvalId: req.approvalId, prNumber: pr.number, prUrl: pr.url }
  } catch (error) {
    await failApprovalExecution(req.approvalId, req.workspaceId, {
      error: error instanceof Error ? error.message : String(error),
    })
    logger.error("Fix PR execution failed", {
      fixProposalId: req.fixProposalId,
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "Fix PR execution failed.",
    }
  }
}

function prBody(req: FixPrRequest, checksum: string): string {
  return [
    `## LyraShield fix proposal`,
    ``,
    `Proposed by LyraShield AI. Approval-gated — a reviewer in your workspace approved this exact patch before it was opened. **Nothing auto-merges; review and merge are yours.**`,
    ``,
    `- Fix proposal: \`${req.fixProposalId}\``,
    `- Base commit: \`${req.baseCommit}\``,
    `- Patch checksum (SHA-256): \`${checksum}\``,
    ``,
    `This PR was prepared for developer review. Verify the change before merging.`,
  ].join("\n")
}
