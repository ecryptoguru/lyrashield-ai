import { getFixProposal } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError } from "../../../../../lib/api-response"
import { z } from "zod"

const CreatePRSchema = z.object({
  workspaceId: z.string().min(1),
})

/**
 * Pull-request creation deliberately fails closed until the proposal pipeline
 * can supply an immutable, server-generated patch and approval binding.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const parsed = CreatePRSchema.safeParse(await request.json())
    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId } = parsed.data
    await requirePermission(workspaceId, PERMISSIONS.fix.createPr)

    const proposal = await getFixProposal(id, workspaceId)
    if (!proposal) return apiError("PROPOSAL_NOT_FOUND", "Fix proposal not found", 404)

    logger.warn("Fix PR creation blocked pending server-generated patch binding", {
      proposalId: proposal.id,
      workspaceId,
    })
    return apiError(
      "PROPOSAL_PATCH_REQUIRED",
      "This proposal has no server-generated approved patch. Regenerate it with patch evidence before creating a pull request.",
      409
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to validate fix PR request", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to validate fix proposal", 500)
  }
}
