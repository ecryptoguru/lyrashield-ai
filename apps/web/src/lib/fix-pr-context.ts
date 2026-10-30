import { getFixProposal, prisma } from "@lyrashield/db"
import { readEncryptedArtifact } from "@lyrashield/evidence-storage"
import { resolveAccountBilling } from "@lyrashield/billing"
import type { WorkspacePlan } from "@lyrashield/types"
import type { FixPrRequest } from "./fix-pr"
import { hasActiveFixPrConnection } from "./fix-pr-connection"
import { env } from "@lyrashield/config"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseComposerFixArtifact } from "@lyrashield/fix"

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
  if (!(await hasActiveFixPrConnection(workspaceId, installationId)))
    throw new FixPrContextError(
      "GITHUB_CONNECTION_INACTIVE",
      "The GitHub connection is no longer active. Reconnect it before requesting a fix."
    )
  const uri = validateFixPrPatchReference(proposal.diffRef, workspaceId, finding.id, proposal.id)
  let artifact
  try {
    artifact = await readEncryptedArtifact(proposal.diffRef, workspaceId)
  } catch (error) {
    if (
      error instanceof Error &&
      (("code" in error && error.code === "ENOENT") ||
        error.name === "NoSuchKey" ||
        error.name === "NotFound")
    ) {
      throw new FixPrContextError(
        "PROPOSAL_PATCH_UNAVAILABLE",
        "This proposal's stored patch is unavailable. Generate a new fix proposal."
      )
    }
    // Credential, encryption-key, permission and service failures remain infrastructure errors.
    throw error
  }
  // Decryption proves storage ownership/integrity, not who produced the bytes.
  // Only fix-generate writes this finding/proposal-bound, content-addressed key;
  // caller-uploaded evidence uses other namespaces and must never execute as a fix.
  // Check stored references too (including legacy drafts and pending approvals).
  const key = `evidence/${workspaceId}/${finding.id}/fix-patch/fix-${proposal.id}-${artifact.checksum}`
  const producerBound =
    /^[a-f0-9]{64}$/.test(artifact.checksum) &&
    (uri.protocol === "s3:"
      ? uri.pathname === `/${key}`
      : uri.protocol === "file:" &&
        fileURLToPath(uri) ===
          resolve(
            env.LYRASHIELD_LOCAL_EVIDENCE_DIR || `${process.cwd()}/.lyrashield/evidence`,
            `${key}.enc`
          ))
  if (!producerBound)
    throw new FixPrContextError(
      "PROPOSAL_PATCH_PROVENANCE_REQUIRED",
      "This proposal's patch is not bound to its server generator. Create a new proposal without a supplied patch reference to generate patch evidence."
    )
  let composerFix
  if (proposal.kind === "composer_update") {
    try {
      composerFix = parseComposerFixArtifact(artifact.content.toString("utf8"))
    } catch {
      throw new FixPrContextError(
        "COMPOSER_FIX_PROVENANCE_REQUIRED",
        "The dependency update receipt is invalid. Generate a new fix proposal from a completed scan."
      )
    }
  }
  return {
    workspaceId,
    targetId: finding.targetId!,
    fixProposalId: proposal.id,
    diff: composerFix?.diff ?? artifact.content.toString("utf8"),
    findingId: finding.id,
    ...(composerFix ? { composerFix } : {}),
    anchorFile,
    implicatedFiles,
    plan: ((await resolveAccountBilling(requestedById))?.effectivePlan ?? "FREE") as WorkspacePlan,
    installationId,
    repoOwner: target.repoOwner,
    repoName: target.repoName,
    baseCommit: finding.baseCommit,
    requestedById,
  }
}

function validateFixPrPatchReference(
  diffRef: string,
  workspaceId: string,
  findingId: string,
  proposalId: string
): URL {
  // Validate the producer namespace before any storage access. Malformed and
  // cross-tenant references are user-actionable conflicts, never storage 500s.
  let uri: URL
  try {
    uri = new URL(diffRef)
    if (uri.search || uri.hash || uri.username || uri.password) throw new Error("Invalid reference")
    if (uri.protocol === "s3:" && env.S3_BUCKET && uri.hostname !== env.S3_BUCKET)
      throw new Error("Invalid reference")
    const prefix = `evidence/${workspaceId}/${findingId}/fix-patch/fix-${proposalId}-`
    const path =
      uri.protocol === "s3:"
        ? uri.pathname.slice(1)
        : uri.protocol === "file:"
          ? fileURLToPath(uri)
              .slice(
                resolve(
                  env.LYRASHIELD_LOCAL_EVIDENCE_DIR || `${process.cwd()}/.lyrashield/evidence`
                ).length + 1
              )
              .replace(/\\/g, "/")
              .replace(/\.enc$/, "")
          : ""
    if (!path.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(path.slice(prefix.length)))
      throw new Error("Invalid reference")
    if (
      uri.protocol === "file:" &&
      fileURLToPath(uri) !==
        resolve(
          env.LYRASHIELD_LOCAL_EVIDENCE_DIR || `${process.cwd()}/.lyrashield/evidence`,
          `${path}.enc`
        )
    )
      throw new Error("Invalid reference")
  } catch {
    throw new FixPrContextError(
      "PROPOSAL_PATCH_PROVENANCE_REQUIRED",
      "This proposal's stored patch reference is invalid. Generate a new fix proposal."
    )
  }
  return uri
}
