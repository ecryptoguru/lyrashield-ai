import { getFinding, prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { z } from "zod"

const CreateRetestSchema = z.object({
  workspaceId: z.string().min(1),
  scanId: z.string().min(1, "scanId is required"),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = CreateRetestSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, scanId } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.retest.create)

    const finding = await getFinding(id, workspaceId)
    if (!finding) {
      return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
    }

    const scan = await prisma.scan.findFirst({
      where: { id: scanId, workspaceId, deletedAt: null },
    })
    if (!scan) {
      return apiError("SCAN_NOT_FOUND", "Scan not found", 404)
    }

    const existingPending = await prisma.retest.findFirst({
      where: {
        findingId: id,
        workspaceId,
        status: { in: ["pending", "running"] },
      },
    })
    if (existingPending) {
      return apiError("RETEST_IN_PROGRESS", "A retest is already in progress for this finding", 409)
    }

    const retest = await prisma.$transaction(async (tx) => {
      const created = await tx.retest.create({
        data: {
          workspaceId,
          findingId: id,
          scanId,
          status: "pending",
        },
      })

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorUserId: session.userId,
          action: "retest.created",
          resourceType: "retest",
          resourceId: created.id,
        },
      })

      return created
    })

    return apiSuccess(retest, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create retest", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create retest", 500)
  }
}
