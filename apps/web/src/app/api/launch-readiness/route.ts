import { prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../lib/api-response"
import { logger } from "@lyrashield/logger"
import { generateLaunchReadinessReportFromAggregate } from "@/lib/launch-readiness"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const targetId = searchParams.get("targetId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.finding.view)

    const [groups, completedScanCount] = await Promise.all([
      prisma.finding.groupBy({
        by: ["severity", "status", "verified"],
        where: {
          workspaceId,
          deletedAt: null,
          ...(targetId ? { targetId } : {}),
        },
        _count: { _all: true },
      }),
      prisma.scan.count({
        where: {
          workspaceId,
          status: "COMPLETED",
          deletedAt: null,
          ...(targetId ? { targetId } : {}),
        },
      }),
    ])

    const report = generateLaunchReadinessReportFromAggregate(
      groups.map((group) => ({ ...group, count: group._count._all })),
      completedScanCount > 0
    )

    return apiSuccess(report)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get launch readiness", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get launch readiness report", 500)
  }
}
