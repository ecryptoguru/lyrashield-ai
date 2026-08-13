import {
  createControlEvidence,
  listControlEvidence,
  prisma,
  type ControlEvidenceVersionSummary,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"
import { buildControlEvidenceList, toPublicControlEvidenceItem } from "@/lib/ai-assurance"
import { z } from "zod"

const CreateEvidenceSchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  controlId: z.string().min(1),
  attestation: z.string().min(1).max(5000),
  expiresAt: z.string().datetime().nullable().default(null),
})

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const targetId = searchParams.get("targetId")

    if (!workspaceId || !targetId) {
      return apiError("MISSING_PARAM", "workspaceId and targetId are required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.aiAssurance.view)

    const target = await prisma.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
      select: { id: true },
    })
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }

    const items = await listControlEvidence({ workspaceId, targetId })
    const response = apiSuccess(buildControlEvidenceList(items))
    response.headers.set("Cache-Control", "private, no-store")
    return response
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list control evidence", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list control evidence", 500)
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const parsed = CreateEvidenceSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, targetId, controlId, attestation, expiresAt } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.aiAssurance.manage)

    const target = await prisma.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
      select: { id: true },
    })
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }

    const version: ControlEvidenceVersionSummary = await createControlEvidence({
      workspaceId,
      targetId,
      controlId,
      attestation,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdById: session.userId,
    })

    return apiSuccess(
      toPublicControlEvidenceItem({
        id: version.controlEvidenceId,
        workspaceId,
        targetId,
        controlId,
        currentVersion: version,
      }),
      201
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message.startsWith("Invalid")) {
      return apiError("INVALID_PARAM", error.message, 400)
    }
    logger.error("Failed to create control evidence", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create control evidence", 500)
  }
}
