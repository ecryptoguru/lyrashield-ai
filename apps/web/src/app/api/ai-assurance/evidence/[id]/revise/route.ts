import { reviseControlEvidence, prisma, type ControlEvidenceVersionSummary } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { toPublicControlEvidenceItem } from "@/lib/ai-assurance"
import { z } from "zod"

const ReviseEvidenceSchema = z.object({
  workspaceId: z.string().min(1),
  attestation: z.string().min(1).max(5000),
  expiresAt: z.string().datetime().nullable().default(null),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json().catch(() => ({}))
    const parsed = ReviseEvidenceSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, attestation, expiresAt } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.aiAssurance.manage)

    const version: ControlEvidenceVersionSummary = await reviseControlEvidence({
      workspaceId,
      evidenceId: id,
      attestation,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdById: session.userId,
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
    if (error instanceof Error && error.message === "EVIDENCE_NOT_FOUND") {
      return apiError("EVIDENCE_NOT_FOUND", "Evidence not found in this workspace", 404)
    }
    logger.error("Failed to revise control evidence", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to revise control evidence", 500)
  }
}
