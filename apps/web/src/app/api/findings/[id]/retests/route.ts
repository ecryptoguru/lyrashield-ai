import { createScan, getFinding, prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"
import { z } from "zod"
import { enqueueScanJob } from "../../../../../lib/queue"

const CreateRetestSchema = z.object({
  workspaceId: z.string().min(1),
  // Retests derive their target and mode from the finding's source scan. Keep
  // this optional only for backwards-compatible clients; it is never trusted.
  scanId: z.string().optional(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = CreateRetestSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.retest.create)

    const finding = await getFinding(id, workspaceId)
    if (!finding) {
      return apiError("FINDING_NOT_FOUND", "Finding not found", 404)
    }

    if (!finding.targetId) {
      return apiError("RETEST_UNAVAILABLE", "This finding has no target to retest", 409)
    }

    const sourceScan = await prisma.scan.findFirst({
      where: { id: finding.scanId, workspaceId, targetId: finding.targetId, deletedAt: null },
      select: { id: true, targetId: true, goal: true, mode: true, policyId: true },
    })
    if (!sourceScan?.targetId) {
      return apiError("RETEST_UNAVAILABLE", "The finding's source scan is unavailable", 409)
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

    let scan: Awaited<ReturnType<typeof createScan>>
    try {
      scan = await createScan({
        workspaceId,
        targetId: sourceScan.targetId,
        goal: sourceScan.goal,
        mode: sourceScan.mode,
        policyId: sourceScan.policyId ?? undefined,
        createdById: session.userId,
        triggerType: "retest",
      })
    } catch (error) {
      if (error instanceof Error && error.message === "Target already has an active scan") {
        return apiError(
          "RETEST_IN_PROGRESS",
          "A retest is already in progress for this target",
          409
        )
      }
      throw error
    }

    const retest = await prisma.retest.create({
      data: {
        workspaceId,
        findingId: id,
        scanId: scan.id,
        status: "pending",
        resultBefore: "Retest queued from the finding's source scan configuration.",
      },
    })

    try {
      await enqueueScanJob({
        scanId: scan.id,
        workspaceId,
        targetId: sourceScan.targetId,
        goal: sourceScan.goal,
        mode: sourceScan.mode,
        policyId: sourceScan.policyId ?? undefined,
      })
    } catch (enqueueError) {
      await prisma.scan.update({
        where: { id: scan.id },
        data: {
          status: "FAILED",
          errorCategory: "QUEUE",
          errorMessage: "Retest could not be queued. Check Redis connectivity.",
          endedAt: new Date(),
        },
      })
      await prisma.retest.update({
        where: { id: retest.id },
        data: { status: "error", resultAfter: "Retest could not be queued." },
      })
      logger.error("Failed to enqueue retest scan", {
        findingId: id,
        scanId: scan.id,
        error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
      })
      return apiError("QUEUE_ERROR", "Retest could not be queued. Try again shortly.", 503)
    }

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "retest.queued",
        resourceType: "retest",
        resourceId: retest.id,
      },
    })

    return apiSuccess({ retest, scan: { id: scan.id, status: scan.status } }, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create retest", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create retest", 500)
  }
}
