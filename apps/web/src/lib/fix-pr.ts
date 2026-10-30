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
  getApproval,
  hashInput,
  createPullRequestRecord,
  beginFixPrExecution,
  getFixPrExecution,
  markFixPrRecovery,
} from "@lyrashield/db"
import {
  createBranch,
  createOrUpdateFile,
  createPullRequest,
  inspectFixPrRemote,
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
  status:
    | "pending_approval"
    | "opening"
    | "opened"
    | "closed"
    | "merged"
    | "recovery_required"
    | "rejected"
    | "failed"
    | "ready"
    | "expired"
    | "stale"
  approvalId?: string
  approvalUrl?: string
  prNumber?: number
  prUrl?: string
  reason?: string
  nextAction?:
    | "request_approval"
    | "check_status"
    | "retest"
    | "regenerate_proposal"
    | "review_pull_request"
    | "reconnect"
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
  if (!proposal)
    return {
      status: "rejected",
      reason: "Fix proposal not found.",
      nextAction: "regenerate_proposal",
    }

  // Validate the diff against the plan-tiered scope policy before any approval
  // exists — an unsound or out-of-scope patch must never be presented as viable.
  const validation = validateRequestPatch(req)
  if (!validation.ok) {
    logger.warn("Fix PR diff rejected by validator", {
      fixProposalId: req.fixProposalId,
      code: "code" in validation ? validation.code : "COMPOSER_SCOPE_MISMATCH",
    })
    return { status: "rejected", reason: validation.reason, nextAction: "regenerate_proposal" }
  }

  const input = buildFixPrApprovalInput(req)
  const { executionKey } = fixPrIdentity(req)
  const existing = await getFixPrExecution(req.workspaceId, req.fixProposalId, executionKey)
  if (existing) return reconcileFixPr(req, existing)
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
    nextAction: "check_status",
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
  const inputHash = hashInput(APPROVAL_ACTION, buildFixPrApprovalInput(req))

  // Re-validate at execution time: the approval binds to this exact hash, but
  // defense-in-depth says re-check the diff against scope before any write.
  const validation = validateRequestPatch(req)
  if (!validation.ok) {
    return { status: "rejected", reason: validation.reason, nextAction: "regenerate_proposal" }
  }

  if (!(await hasActiveFixPrConnection(req.workspaceId, req.installationId))) {
    return {
      status: "rejected",
      reason: "The GitHub connection is no longer active.",
      nextAction: "reconnect",
    }
  }
  const claimed = await claimApprovalExecution(req.approvalId, req.workspaceId, inputHash)
  if (!claimed) {
    return {
      status: "failed",
      nextAction: "check_status",
      approvalId: req.approvalId,
      reason: "Approval is missing, expired, already executed or does not match this patch.",
    }
  }

  const { executionKey, branchName } = fixPrIdentity(req)
  let ownsIntent = false
  let remoteMutationStarted = false
  let failureStatus: "failed" | "stale" = "failed"
  try {
    const intent = await beginFixPrExecution({
      workspaceId: req.workspaceId,
      proposalId: req.fixProposalId,
      executionKey,
      branchName,
      repoOwner: req.repoOwner,
      repoName: req.repoName,
      baseCommit: req.baseCommit,
      diffChecksum: checksum,
      approvalId: req.approvalId,
      requestedById: req.requestedById,
      authorization: req.authorization,
    })
    ownsIntent = intent.created
    if (!ownsIntent) {
      const outcome = await reconcileFixPr(req, intent.record)
      // This caller owns only its approval receipt, never the shared intent.
      // An unknown bookkeeping commit must not terminalize the active owner.
      await completeApprovalExecution(req.approvalId, req.workspaceId, { ...outcome }).catch(() => {
        logger.warn("Fix PR approval result persistence requires reconciliation", {
          approvalId: req.approvalId,
          fixProposalId: req.fixProposalId,
        })
      })
      return outcome
    }
    const baseBranch = await getDefaultBranch(req.installationId, req.repoOwner, req.repoName)
    const fromSha = await getBranchRefSha(
      req.installationId,
      req.repoOwner,
      req.repoName,
      baseBranch
    )
    if (fromSha !== req.baseCommit) {
      failureStatus = "stale"
      throw new Error(
        "The repository changed since this scan. Retest and request a new fix approval."
      )
    }
    const preparedFiles = await prepareFixPrFiles(req, validation.filesTouched, fromSha)
    remoteMutationStarted = true
    await createBranch(req.installationId, req.repoOwner, req.repoName, branchName, fromSha)
    await writeFixPrFiles(req, branchName, preparedFiles)

    const pr = await createPullRequest(
      req.installationId,
      req.repoOwner,
      req.repoName,
      `LyraShield fix proposal ${req.fixProposalId.slice(0, 8)}`,
      `${prBody(req, checksum)}\n\n<!-- lyrashield-fix:${executionKey} -->`,
      branchName,
      baseBranch,
      req.composerFix ? { draft: true } : undefined
    )

    const persisted = await createPullRequestRecord(req.fixProposalId, req.workspaceId, {
      provider: "github",
      executionKey,
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

    return {
      status:
        persisted.status === "open"
          ? "opened"
          : persisted.status === "merged"
            ? "merged"
            : "closed",
      nextAction: "review_pull_request",
      approvalId: req.approvalId,
      prNumber: pr.number,
      prUrl: pr.url,
    }
  } catch {
    const recoveryRequired = remoteMutationStarted || !ownsIntent
    if (ownsIntent)
      await markFixPrRecovery(
        req.workspaceId,
        req.fixProposalId,
        executionKey,
        req.approvalId,
        remoteMutationStarted ? "recovery" : failureStatus
      ).catch(() => undefined)
    await failApprovalExecution(
      req.approvalId,
      req.workspaceId,
      {
        error: recoveryRequired ? "FIX_PR_RECOVERY_REQUIRED" : "FIX_PR_FAILED",
      },
      false
    ).catch(() => undefined)
    logger.error("Fix PR execution failed", {
      fixProposalId: req.fixProposalId,
      code: recoveryRequired ? "FIX_PR_RECOVERY_REQUIRED" : "FIX_PR_FAILED",
    })
    return {
      status: recoveryRequired ? "recovery_required" : failureStatus,
      nextAction: recoveryRequired
        ? "check_status"
        : failureStatus === "stale"
          ? "retest"
          : "regenerate_proposal",
      reason: recoveryRequired
        ? "The GitHub outcome is uncertain. Check PR status to reconcile before any retry."
        : failureStatus === "stale"
          ? "The repository changed since the scan. Retest and generate a new proposal."
          : "Execution stopped before GitHub writes. Review the proposal and generate a new one.",
    }
  }
}

async function prepareFixPrFiles(req: FixPrRequest, filesTouched: string[], fromSha: string) {
  // Prepare every file against the scanned base before any GitHub write.
  // Unreadable content or a hunk mismatch fails closed, without a partial patch.
  const preparedFiles: Array<{ file: string; content: string; sha: string }> = []
  for (const file of filesTouched) {
    const current = await getFileContent(
      req.installationId,
      req.repoOwner,
      req.repoName,
      file,
      fromSha
    )
    if (current === null) {
      throw new Error(`Cannot read ${file} at the scanned commit — patch cannot be applied safely.`)
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
  return preparedFiles
}

async function writeFixPrFiles(
  req: FixPrRequest,
  branchName: string,
  files: Array<{ file: string; content: string; sha: string }>
) {
  for (const { file, content, sha } of files) {
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

/** Shared by approval creation, pre-approval validation, and the atomic execution claim. */
export function buildFixPrApprovalInput(req: FixPrRequest) {
  const checksum = diffChecksum(req.diff)
  return {
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
}

function fixPrIdentity(req: FixPrRequest) {
  const executionKey = createHash("sha256")
    .update(
      JSON.stringify([
        req.workspaceId,
        req.fixProposalId,
        req.repoOwner.toLowerCase(),
        req.repoName.toLowerCase(),
        req.baseCommit,
        diffChecksum(req.diff),
      ])
    )
    .digest("hex")
  return { executionKey, branchName: `lyrashield/fix-${executionKey}` }
}

/** Recovery is read-only at GitHub. Partial branches require operator review, never replay. */
async function reconcileFixPr(
  req: FixPrRequest,
  record: {
    status: string
    createdAt?: Date
    executionKey?: string | null
    prNumber?: number | null
    prUrl?: string | null
  }
): Promise<FixPrOutcome> {
  const storedStatus = record.status
  if (record.executionKey === null)
    return {
      status:
        storedStatus === "closed" || storedStatus === "merged" ? storedStatus : "recovery_required",
      nextAction:
        storedStatus === "closed" || storedStatus === "merged"
          ? "review_pull_request"
          : "check_status",
      ...(record.prNumber ? { prNumber: record.prNumber } : {}),
      ...(record.prUrl ? { prUrl: record.prUrl } : {}),
      reason:
        "This earlier pull request has no execution identity. Review its recorded GitHub link before creating another proposal.",
    }
  if (storedStatus === "stale")
    return {
      status: "stale",
      nextAction: "retest",
      reason: "The repository changed since the scan. Retest and generate a new proposal.",
    }
  if (storedStatus === "failed")
    return {
      status: "failed",
      nextAction: "regenerate_proposal",
      reason: "Execution stopped before GitHub writes. Review the proposal and generate a new one.",
    }
  const { executionKey, branchName } = fixPrIdentity(req)
  try {
    const remote = await inspectFixPrRemote(
      req.installationId,
      req.repoOwner,
      req.repoName,
      branchName,
      `<!-- lyrashield-fix:${executionKey} -->`
    )
    if (!remote.pullRequest)
      return {
        status:
          storedStatus === "opening" &&
          !remote.branchExists &&
          (!record.createdAt || Date.now() - record.createdAt.getTime() < 120_000)
            ? "opening"
            : "recovery_required",
        nextAction: "check_status",
        reason:
          "An execution already exists. Check status; uncertain GitHub writes are never replayed.",
      }
    const pr = remote.pullRequest
    const persisted = await createPullRequestRecord(req.fixProposalId, req.workspaceId, {
      provider: "github",
      executionKey,
      repoOwner: req.repoOwner,
      repoName: req.repoName,
      branchName,
      prNumber: pr.number,
      prUrl: pr.url,
      status: pr.status,
    })
    return {
      status:
        persisted.status === "open"
          ? "opened"
          : persisted.status === "merged"
            ? "merged"
            : "closed",
      nextAction: "review_pull_request",
      prNumber: pr.number,
      prUrl: pr.url,
    }
  } catch {
    return {
      status: "recovery_required",
      nextAction: "check_status",
      reason: "Unable to confirm the GitHub outcome. Check status again before retrying.",
    }
  }
}

/** Status checks never claim approval or replay GitHub mutations. */
export async function getFixPrStatus(
  req: FixPrRequest,
  approvalId?: string
): Promise<FixPrOutcome> {
  const { executionKey } = fixPrIdentity(req)
  const execution = await getFixPrExecution(req.workspaceId, req.fixProposalId, executionKey)
  if (execution) return reconcileFixPr(req, execution)
  if (!approvalId) return { status: "ready", nextAction: "request_approval" }
  const approval = await getApproval(approvalId, req.workspaceId)
  if (
    !approval ||
    approval.actionName !== APPROVAL_ACTION ||
    approval.inputHash !== hashInput(APPROVAL_ACTION, buildFixPrApprovalInput(req))
  )
    return {
      status: "stale",
      nextAction: "request_approval",
      reason: "The approval no longer matches this stored patch. Request a new approval.",
    }
  if (
    ["EXPIRED", "PENDING", "APPROVED"].includes(approval.status) &&
    approval.expiresAt &&
    approval.expiresAt <= new Date()
  )
    return {
      status: "expired",
      nextAction: "request_approval",
      reason: "Approval expired. Request a new approval for this stored patch.",
    }
  if (approval.status === "PENDING")
    return { status: "pending_approval", approvalId, nextAction: "check_status" }
  if (approval.status === "EXPIRED")
    return {
      status: "expired",
      nextAction: "request_approval",
      reason: "Approval expired. Request a new approval for this stored patch.",
    }
  if (["APPROVED", "EXECUTING"].includes(approval.status))
    return { status: "opening", approvalId, nextAction: "check_status" }
  return {
    nextAction:
      approval.status === "EXECUTION_FAILED" || approval.status === "EXECUTED"
        ? "check_status"
        : "request_approval",
    status:
      approval.status === "EXECUTION_FAILED" || approval.status === "EXECUTED"
        ? "recovery_required"
        : "failed",
  }
}
