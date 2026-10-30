import { withWorkspaceRLS } from "./rls"

/** Reads always traverse the proposal's tenant boundary, including terminal records. */
export async function getFixPrExecution(
  workspaceId: string,
  proposalId: string,
  executionKey: string
) {
  return withWorkspaceRLS(workspaceId, async (tx) => {
    const scope = {
      fixProposalId: proposalId,
      deletedAt: null,
      fixProposal: { deletedAt: null, finding: { workspaceId, deletedAt: null } },
    }
    return (
      (await tx.pullRequest.findFirst({ where: { ...scope, executionKey } })) ??
      (await tx.pullRequest.findFirst({
        where: { ...scope, executionKey: null, provider: "github" },
      }))
    )
  })
}

/** Exactly one caller may perform GitHub mutations for this immutable patch identity. */
export async function beginFixPrExecution(params: {
  workspaceId: string
  proposalId: string
  executionKey: string
  branchName: string
  repoOwner: string
  repoName: string
  baseCommit: string
  diffChecksum: string
  approvalId: string
  requestedById: string
  authorization?: { kind: "oauth-connection" | "api-key"; id: string }
}) {
  return withWorkspaceRLS(params.workspaceId, async (tx) => {
    const proposal = await tx.fixProposal.findFirst({
      where: {
        id: params.proposalId,
        deletedAt: null,
        finding: { workspaceId: params.workspaceId, deletedAt: null },
      },
    })
    if (!proposal) throw new Error("Fix proposal not found in workspace")
    // Existing legacy history has no verifiable immutable execution identity.
    // Preserve it for operator recovery instead of opening a replacement PR.
    const legacy = await tx.pullRequest.findFirst({
      where: {
        fixProposalId: params.proposalId,
        executionKey: null,
        provider: "github",
        deletedAt: null,
        fixProposal: { finding: { workspaceId: params.workspaceId } },
      },
    })
    if (legacy) return { created: false, record: legacy }
    const inserted = await tx.pullRequest.createMany({
      skipDuplicates: true,
      data: [
        {
          fixProposalId: params.proposalId,
          provider: "github",
          repoOwner: params.repoOwner,
          repoName: params.repoName,
          branchName: params.branchName,
          executionKey: params.executionKey,
          baseCommit: params.baseCommit,
          diffChecksum: params.diffChecksum,
          approvalId: params.approvalId,
          requestedById: params.requestedById,
          credentialActor: params.authorization ?? { kind: "browser", id: params.requestedById },
          status: "opening",
        },
      ],
    })
    const record = await tx.pullRequest.findFirst({
      where: {
        executionKey: params.executionKey,
        fixProposalId: params.proposalId,
        fixProposal: { finding: { workspaceId: params.workspaceId } },
        deletedAt: null,
      },
    })
    if (!record) throw new Error("Fix PR execution identity unavailable")
    return { created: inserted.count === 1, record }
  })
}

/** Ambiguous side effects are never automatically replayed. */
export async function markFixPrRecovery(
  workspaceId: string,
  proposalId: string,
  executionKey: string,
  approvalId: string,
  status: "recovery" | "failed" | "stale" = "recovery"
) {
  return withWorkspaceRLS(workspaceId, (tx) =>
    tx.pullRequest.updateMany({
      where: {
        executionKey,
        approvalId,
        fixProposalId: proposalId,
        status: "opening",
        deletedAt: null,
        fixProposal: { finding: { workspaceId } },
      },
      data: { status },
    })
  )
}
