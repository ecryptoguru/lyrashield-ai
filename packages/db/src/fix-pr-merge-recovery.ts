import { createHash } from "node:crypto"
import { z } from "zod"
import type { ScopedTransaction } from "./rls"
import type { PullRequest } from "./generated/prisma"
import { verifyInputHash } from "./agent-approval-service"

const StoredFixInput = z
  .object({
    actionName: z.literal("fix_pr.open"),
    fixProposalId: z.string(),
    diffChecksum: z.string(),
    baseCommit: z.string(),
    targetRepo: z.string(),
  })
  .passthrough()

/** Only the authenticated webhook's exact deterministic branch may recover an uncertain write. */
export async function isRecoverableFixPrMerge(
  tx: ScopedTransaction,
  record: PullRequest,
  event: {
    workspaceId: string
    branchName: string
    repoFullName?: string
    prNumber?: number
    recoveryIdentity?: { headRepoFullName: string; body: string }
  }
): Promise<boolean> {
  if (
    !["opening", "recovery"].includes(record.status) ||
    !record.executionKey ||
    !record.baseCommit ||
    !record.diffChecksum ||
    !record.approvalId ||
    !event.repoFullName ||
    event.recoveryIdentity?.headRepoFullName !== event.repoFullName ||
    !event.recoveryIdentity.body.includes(`<!-- lyrashield-fix:${record.executionKey} -->`) ||
    !Number.isSafeInteger(event.prNumber) ||
    event.prNumber! <= 0 ||
    event.repoFullName !== `${record.repoOwner}/${record.repoName}` ||
    event.branchName !== `lyrashield/fix-${record.executionKey}` ||
    (record.prNumber !== null && record.prNumber !== event.prNumber)
  )
    return false
  // Same immutable tuple as the web executor; actors and approval IDs cannot fork it.
  const reconstructed = createHash("sha256")
    .update(
      JSON.stringify([
        event.workspaceId,
        record.fixProposalId,
        record.repoOwner.toLowerCase(),
        record.repoName.toLowerCase(),
        record.baseCommit,
        record.diffChecksum,
      ])
    )
    .digest("hex")
  if (reconstructed !== record.executionKey) return false
  const approval = await tx.agentApproval.findFirst({
    where: {
      id: record.approvalId,
      workspaceId: event.workspaceId,
      actionName: "fix_pr.open",
      status: { in: ["EXECUTING", "EXECUTED", "EXECUTION_FAILED"] },
      attempts: { gt: 0 },
    },
  })
  if (!approval) return false
  const parsed = StoredFixInput.safeParse(approval.input)
  if (!parsed.success || !verifyInputHash("fix_pr.open", parsed.data, approval.inputHash))
    return false
  const input = parsed.data
  return (
    input.fixProposalId === record.fixProposalId &&
    input.diffChecksum === record.diffChecksum &&
    input.baseCommit === record.baseCommit &&
    input.targetRepo === `${record.repoOwner}/${record.repoName}`
  )
}
