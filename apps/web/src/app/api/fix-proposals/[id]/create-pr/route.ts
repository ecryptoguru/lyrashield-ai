import { withCookieMutation } from "../../../../../lib/api-auth"
import { z } from "zod"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { getFixProposal, prisma } from "@lyrashield/db"
import { readEncryptedArtifact } from "@lyrashield/evidence-storage"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { requestFixPrApproval } from "@/lib/fix-pr"

const CreatePRSchema = z
  .object({
    workspaceId: z.string().min(1),
  })
  .strict()

/**
 * POST /api/fix-proposals/[id]/create-pr
 *
 * WP3: turn a fix proposal with a server-generated patch into an approval-bound
 * pull request. The patch is read from the proposal's stored artifact
 * (diffRef → evidence storage), validated against the plan-tiered scope policy
 * BEFORE any approval is created, then bound to a human approval. The approval
 * (fix.approve — tighter than fix.create) is what authorizes execution.
 *
 * Fail-closed: a proposal with no stored patch, no resolvable repo target, or
 * a patch that fails validation returns a named rejection — never a
 * half-opened PR.
 */
async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const parsed = CreatePRSchema.safeParse(await request.json())
    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId } = parsed.data
    const { session } = await requirePermission(workspaceId, PERMISSIONS.fix.createPr)

    const proposal = await getFixProposal(id, workspaceId)
    if (!proposal) return apiError("PROPOSAL_NOT_FOUND", "Fix proposal not found", 404)

    // A proposal without a server-generated patch stays fail-closed.
    if (!proposal.diffRef) {
      logger.warn("Fix PR creation blocked: no server-generated patch", {
        proposalId: proposal.id,
        workspaceId,
      })
      return apiError(
        "PROPOSAL_PATCH_REQUIRED",
        "This proposal has no server-generated approved patch. Regenerate it with patch evidence before creating a pull request.",
        409
      )
    }

    // Resolve the finding's target (repo + installation), base commit, and
    // implicated files. All reads are workspace-scoped (RLS).
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
    if (!finding) return apiError("PROPOSAL_NOT_FOUND", "Fix proposal not found", 404)

    const target = finding.target
    if (
      !target ||
      target.deletedAt ||
      !target.repoOwner ||
      !target.repoName ||
      !target.installationId
    ) {
      return apiError(
        "NO_REPOSITORY_LINK",
        "This finding's target is not linked to a connected GitHub repository.",
        409
      )
    }
    if (!finding.baseCommit) {
      return apiError(
        "NO_BASE_COMMIT",
        "The scan that produced this finding did not record a base commit to patch against.",
        409
      )
    }

    const implicatedFiles = Array.isArray(finding.implicatedFiles)
      ? (finding.implicatedFiles as unknown[]).filter((f): f is string => typeof f === "string")
      : []
    const anchorFile = implicatedFiles[0]
    if (!anchorFile) {
      return apiError(
        "NO_IMPLICATED_FILE",
        "This finding has no implicated file to scope a patch to.",
        409
      )
    }

    // Read the patch from evidence storage (workspace-scoped, integrity-checked).
    const artifact = await readEncryptedArtifact(proposal.diffRef, workspaceId)
    const diff = artifact.content.toString("utf8")

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true },
    })
    if (!workspace) return apiError("NOT_FOUND", "Workspace not found", 404)

    const installationId = Number(target.installationId)
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return apiError("NO_REPOSITORY_LINK", "Invalid GitHub installation on this target.", 409)
    }

    const outcome = await requestFixPrApproval(
      {
        workspaceId,
        fixProposalId: proposal.id,
        diff,
        anchorFile,
        implicatedFiles,
        plan: workspace.plan,
        installationId,
        repoOwner: target.repoOwner,
        repoName: target.repoName,
        baseCommit: finding.baseCommit,
        requestedById: session.userId,
      },
      env.NEXT_PUBLIC_APP_URL
    )

    if (outcome.status === "rejected") {
      return apiError("PATCH_REJECTED", outcome.reason ?? "Patch failed validation", 422)
    }
    return apiSuccess(outcome, 200)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to validate fix PR request", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to validate fix proposal", 500)
  }
}

export const POST = withCookieMutation(post)
