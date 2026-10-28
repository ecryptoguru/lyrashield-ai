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

import { createHash } from "node:crypto"
import { hasActiveFixPrConnection } from "./fix-pr-connection"

import {
  claimApprovalExecution,
  completeApprovalExecution,
  createApproval,
  failApprovalExecution,
  findOrCreatePendingApproval,
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
  validateComposerFixArtifact,
  type ComposerFixArtifact,
} from "@lyrashield/fix"
import { logger } from "@lyrashield/logger"

const APPROVAL_ACTION = "fix_pr.open"
const APPROVAL_TTL_MINUTES = 15

export interface FixPrRequest {
  workspaceId: string
  targetId: string
  fixProposalId: string
  /** Server-resolved finding and isolated resolver receipt; never accepted from a client. */
  findingId?: string
  composerFix?: ComposerFixArtifact
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
  /** Present only after the route verifies current credential permissions and target scope. */
  authorization?: { kind: "oauth-connection" | "api-key"; id: string }
}

interface FixPrOutcome {
  status: "pending_approval" | "opened" | "rejected" | "failed"
  approvalId?: string
  approvalUrl?: string
  prNumber?: number
  prUrl?: string
  reason?: string
}

function approvalUrl(base: string, approvalId: string): string {
  return `${base.replace(/\/+$/, "")}/dashboard/approvals?approval=${encodeURIComponent(approvalId)}`
}

function validateRequestPatch(req: FixPrRequest) {
  const policy = patchScopeForPlan(req.plan)
  if (!req.composerFix)
    return validatePatchDiff(req.diff, req.anchorFile, req.implicatedFiles, policy)
  if (
    req.diff !== req.composerFix.diff ||
    req.anchorFile !== req.composerFix.lockPath ||
    req.implicatedFiles.length !== 1 ||
    req.implicatedFiles[0] !== req.anchorFile
  ) {
    return {
      ok: false as const,
      reason: "Composer patch does not match its server-generated scope.",
    }
  }
  return validateComposerFixArtifact(
    req.composerFix,
    {
      workspaceId: req.workspaceId,
      targetId: req.targetId,
      findingId: req.findingId ?? "",
      proposalId: req.fixProposalId,
      baseCommit: req.baseCommit,
    },
    policy
  )
}

/**
 * Validate a fix PR and bind its exact patch to an audited authorization receipt.
 * Authorized credentials execute immediately; browser requests retain review.
 */
export async function requestFixPrApproval(
  req: FixPrRequest,
  appUrl: string
): Promise<FixPrOutcome> {
  const proposal = await getFixProposal(req.fixProposalId, req.workspaceId)
  if (!proposal) return { status: "rejected", reason: "Fix proposal not found." }

  // Validate the diff against the plan-tiered scope policy before any approval
  // exists — an unsound or out-of-scope patch must never be presented as viable.
  const validation = validateRequestPatch(req)
  if (!validation.ok) {
    logger.warn("Fix PR diff rejected by validator", {
      fixProposalId: req.fixProposalId,
      code: "code" in validation ? validation.code : "COMPOSER_SCOPE_MISMATCH",
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
    ...(req.composerFix
      ? {
          composerReceiptChecksum: diffChecksum(JSON.stringify(req.composerFix)),
          title: "Open draft Composer update PR: compatibility tests required",
          compatibility:
            "Application compatibility is unverified; open a draft PR for customer CI and review.",
          prMode: "draft",
        }
      : {}),
  }
  const approvalParams = {
    workspaceId: req.workspaceId,
    actionName: APPROVAL_ACTION,
    input,
    requestedById: req.requestedById,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MINUTES * 60 * 1000),
  }
  const approval = req.authorization
    ? await createApproval({ ...approvalParams, authorization: req.authorization })
    : await findOrCreatePendingApproval(approvalParams)

  if (req.authorization) return executeApprovedFixPr({ ...req, approvalId: approval.id })

  return {
    status: "pending_approval",
    approvalId: approval.id,
    approvalUrl: approvalUrl(appUrl, approval.id),
  }
}

/**
 * Execute an authorized fix PR. Claims the
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
    ...(req.composerFix
      ? {
          composerReceiptChecksum: diffChecksum(JSON.stringify(req.composerFix)),
          title: "Open draft Composer update PR: compatibility tests required",
          compatibility:
            "Application compatibility is unverified; open a draft PR for customer CI and review.",
          prMode: "draft",
        }
      : {}),
  }
  const inputHash = hashInput(APPROVAL_ACTION, input)

  // Re-validate at execution time: the approval binds to this exact hash, but
  // defense-in-depth says re-check the diff against scope before any write.
  const validation = validateRequestPatch(req)
  if (!validation.ok) {
    return { status: "rejected", reason: validation.reason }
  }

  if (!(await hasActiveFixPrConnection(req.workspaceId, req.installationId))) {
    return { status: "rejected", reason: "The GitHub connection is no longer active." }
  }
  const claimed = await claimApprovalExecution(req.approvalId, req.workspaceId, inputHash)
  if (!claimed) {
    return {
      status: "failed",
      reason: "Approval is missing, expired, already executed or does not match this patch.",
    }
  }

  const branchSuffix = createHash("sha256").update(req.approvalId).digest("hex").slice(0, 12)
  const branchName = `lyrashield/fix-${req.fixProposalId.slice(0, 12)}-${branchSuffix}`
  try {
    const baseBranch = await getDefaultBranch(req.installationId, req.repoOwner, req.repoName)
    const fromSha = await getBranchRefSha(
      req.installationId,
      req.repoOwner,
      req.repoName,
      baseBranch
    )
    if (fromSha !== req.baseCommit) {
      throw new Error(
        "The repository changed since this scan. Retest and request a new fix approval."
      )
    }
    // Apply the validated diff file-by-file: fetch current content at the base
    // commit, apply the unified diff (fail-closed on any hunk mismatch), write
    // the result to the fix branch. A file with no readable content is a hard
    // failure — we never write a partial patch.
    const preparedFiles: Array<{ file: string; content: string; sha: string }> = []
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
      if (req.composerFix && current !== req.composerFix.before) {
        throw new Error(
          "The Composer lock no longer matches its resolver receipt. Retest and regenerate the proposal."
        )
      }
      const newContent = applyUnifiedDiff(current, extractFileDiff(req.diff, file))
      if (req.composerFix && newContent !== req.composerFix.after)
        throw new Error("Composer patch result differs from the resolver output")
      const bytes = Buffer.from(current, "utf8")
      const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
      preparedFiles.push({ file, content: newContent, sha })
    }
    await createBranch(req.installationId, req.repoOwner, req.repoName, branchName, fromSha)
    for (const { file, content, sha } of preparedFiles) {
      await createOrUpdateFile(
        req.installationId,
        req.repoOwner,
        req.repoName,
        file,
        content,
        `fix: ${req.fixProposalId}`,
        branchName,
        sha
      )
    }

    const pr = await createPullRequest(
      req.installationId,
      req.repoOwner,
      req.repoName,
      `LyraShield fix proposal ${req.fixProposalId.slice(0, 8)}`,
      prBody(req, checksum),
      branchName,
      baseBranch,
      req.composerFix ? { draft: true } : undefined
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
    await failApprovalExecution(
      req.approvalId,
      req.workspaceId,
      {
        error: error instanceof Error ? error.message : String(error),
      },
      false
    )
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
    `Proposed by LyraShield AI. Authorized through your workspace permissions and bound to this exact patch before execution. **Nothing auto-merges; review and merge are yours.**`,
    ``,
    `- Fix proposal: \`${req.fixProposalId}\``,
    `- Base commit: \`${req.baseCommit}\``,
    `- Patch checksum (SHA-256): \`${checksum}\``,
    ``,
    `This PR was prepared for developer review. Verify the change before merging.`,
    ...(req.composerFix
      ? [
          "",
          `Composer upgraded ${req.composerFix.packageName} from ${req.composerFix.fromVersion} to ${req.composerFix.toVersion} in an isolated resolver with networking, scripts, plugins and installation disabled. Lock consistency passed.`,
          "This PR is a draft because application compatibility is unverified. Run your application compatibility tests and CI before marking it ready for merge; package-manager consistency is not application compatibility proof.",
        ]
      : []),
  ].join("\n")
}
