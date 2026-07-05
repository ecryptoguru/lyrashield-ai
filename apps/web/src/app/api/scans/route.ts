import { prisma, createScan, listScans } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { CreateScanSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiPaginated, apiSuccess, parsePaginationParams } from "../../../lib/api-response"
import { enqueueScanJob } from "../../../lib/queue"

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const parsed = CreateScanSchema.safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", parsed.error.message, 400)
  }

  const data = parsed.data
  const workspaceId = data.workspaceId

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.scan.create)

    const target = await prisma.target.findFirst({
      where: { id: data.targetId, workspaceId, deletedAt: null },
    })
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }

    if (data.policyId) {
      const policy = await prisma.policy.findFirst({
        where: { id: data.policyId, workspaceId, deletedAt: null },
      })
      if (!policy) {
        return apiError("POLICY_NOT_FOUND", "Policy not found in this workspace", 404)
      }
    }

    const activeScans = await prisma.scan.count({
      where: {
        targetId: data.targetId,
        status: { in: ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"] },
      },
    })
    if (activeScans > 0) {
      return apiError("SCAN_IN_PROGRESS", "Target already has an active scan. Cancel it or wait for completion.", 409)
    }

    const scan = await createScan({
      workspaceId,
      targetId: data.targetId,
      goal: data.goal,
      mode: data.mode,
      policyId: data.policyId,
      createdById: session.userId,
    })

    try {
      await enqueueScanJob({
        scanId: scan.id,
        workspaceId,
        targetId: data.targetId,
        goal: data.goal,
        mode: data.mode,
        policyId: data.policyId,
      })
    } catch (enqueueErr) {
      logger.error("Failed to enqueue scan job", {
        scanId: scan.id,
        error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
      })
      await prisma.scan.update({
        where: { id: scan.id },
        data: {
          status: "FAILED",
          errorCategory: "QUEUE",
          errorMessage: "Failed to enqueue scan job — Redis may be unavailable",
          endedAt: new Date(),
        },
      })
      return apiError("QUEUE_ERROR", "Scan created but failed to enqueue. Check Redis connectivity.", 503)
    }

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "scan.created",
        resourceType: "scan",
        resourceId: scan.id,
      },
    })

    logger.info("Scan created and enqueued", { scanId: scan.id, workspaceId, targetId: data.targetId })

    return apiSuccess({
      id: scan.id,
      status: scan.status,
      goal: scan.goal,
      mode: scan.mode,
      targetId: scan.targetId,
      createdAt: scan.createdAt,
    }, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create scan", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create scan", 500)
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const targetId = searchParams.get("targetId")
    const status = searchParams.get("status")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.scan.view)

    const { cursor, limit } = parsePaginationParams(searchParams)

    const { items, nextCursor } = await listScans({
      workspaceId,
      ...(targetId ? { targetId } : {}),
      ...(status ? { status: status as never } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    })

    return apiPaginated(items, nextCursor)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list scans", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list scans", 500)
  }
}
