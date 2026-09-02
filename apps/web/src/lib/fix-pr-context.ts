import { getFixProposal, prisma } from "@lyrashield/db"
import { readEncryptedArtifact } from "@lyrashield/evidence-storage"
import type { FixPrRequest } from "./fix-pr"

export class FixPrContextError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409
  ) {
    super(message)
  }
}

/** Resolve every execution field from stored, workspace-bound records. */
export async function resolveFixPrRequest(
  workspaceId: string,
  proposalId: string,
  requestedById: string
): Promise<FixPrRequest> {
  const proposal = await getFixProposal(proposalId, workspaceId)
  if (!proposal) throw new FixPrContextError("PROPOSAL_NOT_FOUND", "Fix proposal not found", 404)
  if (!proposal.diffRef)
    throw new FixPrContextError(
      "PROPOSAL_PATCH_REQUIRED",
      "This proposal has no server-generated approved patch. Regenerate it with patch evidence before creating a pull request."
    )
  const finding = await prisma.finding.findFirst({
    where: { id: proposal.findingId, workspaceId, deletedAt: null },
    select: {
      id: true,
      targetId: true,
      implicatedFiles: true,
      baseCommit: true,
      target: {
        select: { repoOwner: true, repoName: true, installationId: true, deletedAt: true },
      },
    },
  })
  if (!finding) throw new FixPrContextError("PROPOSAL_NOT_FOUND", "Fix proposal not found", 404)
  const target = finding.target
  if (
    !target ||
    target.deletedAt ||
    !target.repoOwner ||
    !target.repoName ||
    !target.installationId
  ) {
    throw new FixPrContextError(
      "NO_REPOSITORY_LINK",
      "This finding's target is not linked to a connected GitHub repository."
    )
  }
  if (!finding.baseCommit)
    throw new FixPrContextError(
      "NO_BASE_COMMIT",
      "The scan that produced this finding did not record a base commit to patch against."
    )
  const implicatedFiles = Array.isArray(finding.implicatedFiles)
    ? finding.implicatedFiles.filter((file): file is string => typeof file === "string")
    : []
  const anchorFile = implicatedFiles[0]
  if (!anchorFile)
    throw new FixPrContextError(
      "NO_IMPLICATED_FILE",
      "This finding has no implicated file to scope a patch to."
    )
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true },
  })
  if (!workspace) throw new FixPrContextError("NOT_FOUND", "Workspace not found", 404)
  const installationId = Number(target.installationId)
  if (!Number.isInteger(installationId) || installationId <= 0)
    throw new FixPrContextError("NO_REPOSITORY_LINK", "Invalid GitHub installation on this target.")
  const artifact = await readEncryptedArtifact(proposal.diffRef, workspaceId)
  return {
    workspaceId,
    fixProposalId: proposal.id,
    diff: artifact.content.toString("utf8"),
    anchorFile,
    implicatedFiles,
    plan: workspace.plan,
    installationId,
    repoOwner: target.repoOwner,
    repoName: target.repoName,
    baseCommit: finding.baseCommit,
    requestedById,
  }
}
