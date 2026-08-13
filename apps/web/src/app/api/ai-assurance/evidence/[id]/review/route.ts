import { reviewControlEvidence, prisma, type ControlEvidenceVersionSummary } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { toPublicControlEvidenceItem } from "@/lib/ai-assurance"
import { z } from "zod"

const ReviewEvidenceSchema = z.object({
  workspaceId: z.string().min(1),
  versionId: z.string().min(1),
  status: z.enum(["ACCEPTED", "REJECTED"]),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json().catch(() => ({}))
    const parsed = ReviewEvidenceSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, versionId, status } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.aiAssurance.review)

    const version: ControlEvidenceVersionSummary = await reviewControlEvidence({
      workspaceId,
      evidenceId: id,
      versionId,
      status,
      reviewerId: session.userId,
    })

    const evidence = await prisma.controlEvidence.findFirst({
      where: { id: version.controlEvidenceId, workspaceId },
    })
    if (!evidence) {
      return apiError("EVIDENCE_NOT_FOUND", "Evidence not found in this workspace", 404)
    }

    return apiSuccess(
      toPublicControlEvidenceItem({
        id: evidence.id,
        workspaceId: evidence.workspaceId,
        targetId: evidence.targetId,
        controlId: evidence.controlId,
        currentVersion: version,
      })
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message === "EVIDENCE_VERSION_NOT_REVIEWABLE") {
      return apiError("EVIDENCE_VERSION_NOT_REVIEWABLE", "Evidence version is not reviewable", 409)
    }
    if (error instanceof Error && error.message === "EVIDENCE_VERSION_STALE") {
      return apiError(
        "EVIDENCE_VERSION_STALE",
        "Evidence changed before review; reload and review the current version",
        409
      )
    }
    if (error instanceof Error && error.message === "EVIDENCE_NOT_FOUND") {
      return apiError("EVIDENCE_NOT_FOUND", "Evidence not found in this workspace", 404)
    }
    logger.error("Failed to review control evidence", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to review control evidence", 500)
  }
}
