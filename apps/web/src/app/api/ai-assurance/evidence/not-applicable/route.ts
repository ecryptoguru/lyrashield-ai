import {
  markControlEvidenceNotApplicable,
  prisma,
  type ControlEvidenceVersionSummary,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { toPublicControlEvidenceItem } from "@/lib/ai-assurance"
import { z } from "zod"

const NotApplicableSchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  controlId: z.string().min(1),
  reason: z.string().trim().min(1).max(5000),
})

export async function POST(request: Request) {
  try {
    const parsed = NotApplicableSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId, targetId, controlId, reason } = parsed.data
    const { session } = await requirePermission(workspaceId, PERMISSIONS.aiAssurance.manage)
    const target = await prisma.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
      select: { id: true },
    })
    if (!target) return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)

    const version: ControlEvidenceVersionSummary = await markControlEvidenceNotApplicable({
      workspaceId,
      targetId,
      controlId,
      reason,
      createdById: session.userId,
    })
    const evidence = await prisma.controlEvidence.findFirst({
      where: { id: version.controlEvidenceId, workspaceId },
      select: { id: true, workspaceId: true, targetId: true, controlId: true },
    })
    if (!evidence)
      return apiError("EVIDENCE_NOT_FOUND", "Evidence not found in this workspace", 404)
    const response = apiSuccess(
      toPublicControlEvidenceItem({ ...evidence, currentVersion: version })
    )
    response.headers.set("Cache-Control", "private, no-store")
    return response
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message === "EVIDENCE_NOT_APPLICABLE_REASON_REQUIRED") {
      return apiError(
        "INVALID_PARAM",
        "A reason is required when marking a control not applicable",
        400
      )
    }
    logger.error("Failed to mark control evidence not applicable", {
      error: error instanceof Error ? error.message : String(error),
    })
    return apiError("INTERNAL_ERROR", "Failed to mark control evidence not applicable", 500)
  }
}
