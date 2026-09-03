import { prisma, withWorkspaceRLS } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../lib/api-response"
import { logger } from "@lyrashield/logger"
import {
  INCOMPLETE_APPLICABLE_RECEIPT_STATUSES,
  generateLaunchReadinessReportFromAggregate,
} from "@/lib/launch-readiness"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const targetId = searchParams.get("targetId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.finding.view)

    const [groups, completedScanCount, evaluatedCoverageCount, unresolvedCoverageCount] =
      await Promise.all([
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
        // Whether any completed scan actually evaluated the target. Zero findings
        // with zero coverage must not read as a pass.
        withWorkspaceRLS(workspaceId, (tx) =>
          tx.scanCoverageReceipt.count({
            where: {
              status: "COMPLETED",
              scan: {
                workspaceId,
                status: "COMPLETED",
                deletedAt: null,
                ...(targetId ? { targetId } : {}),
              },
            },
          })
        ),
        // Applicable controls that did not complete. Without this a run where one
        // scanner completed and the rest were blocked scores a clean 100/100 GO.
        withWorkspaceRLS(workspaceId, (tx) =>
          tx.scanCoverageReceipt.count({
            where: {
              status: { in: [...INCOMPLETE_APPLICABLE_RECEIPT_STATUSES] },
              scan: {
                workspaceId,
                status: "COMPLETED",
                deletedAt: null,
                ...(targetId ? { targetId } : {}),
              },
            },
          })
        ),
      ])

    const report = generateLaunchReadinessReportFromAggregate(
      groups.map((group) => ({ ...group, count: group._count._all })),
      completedScanCount > 0,
      {
        evaluated: evaluatedCoverageCount > 0,
        unresolvedControls: unresolvedCoverageCount,
        reason:
          "No scanner successfully evaluated this target. Open the latest run's coverage notice for the specific reason.",
      }
    )

    const response = apiSuccess(report)
    response.headers.set("Cache-Control", "private, max-age=30, stale-while-revalidate=60")
    return response
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get launch readiness", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get launch readiness report", 500)
  }
}
