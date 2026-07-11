import { createFixProposal, getFinding } from "@lyrashield/db"
import { prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { z } from "zod"

const CreateFixProposalSchema = z.object({
  workspaceId: z.string().min(1),
  summary: z.string().min(10, "Summary must be at least 10 characters"),
  diffRef: z.string().optional(),
  generatedByModel: z.string().optional(),
  safetyScore: z.number().int().min(0).max(100).optional(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = CreateFixProposalSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, summary, diffRef, generatedByModel, safetyScore } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.fix.create)

    const finding = await getFinding(id, workspaceId)
    if (!finding) {
      return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
    }

    const proposal = await createFixProposal({
      findingId: id,
      workspaceId,
      summary,
      ...(diffRef ? { diffRef } : {}),
      ...(generatedByModel ? { generatedByModel } : {}),
      ...(safetyScore != null ? { safetyScore } : {}),
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "fix_proposal.created",
        resourceType: "fix_proposal",
        resourceId: proposal.id,
      },
    })

    return apiSuccess(proposal)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create fix proposal", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create fix proposal", 500)
  }
}
