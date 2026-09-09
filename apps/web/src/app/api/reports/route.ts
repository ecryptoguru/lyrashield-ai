import { recordedOperation } from "@/lib/recorded-operation"
import { withCookieMutation } from "../../../lib/api-auth"
import { listReports, createReport, prisma } from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import {
  apiError,
  apiSuccess,
  apiPaginated,
  parsePaginationParams,
} from "../../../lib/api-response"
import { z } from "zod"
import { revalidateDashboardAggregates } from "../../../lib/cache"

const CreateReportSchema = z.object({
  workspaceId: z.string().min(1),
  scanId: z.string().optional(),
  targetId: z.string().optional(),
  type: z.enum(["developer", "executive", "compliance"]).optional(),
  title: z.string().min(1).max(200),
})

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.report.download)

    const { cursor, limit } = parsePaginationParams(searchParams)
    const { items, nextCursor } = await listReports(workspaceId, cursor ?? undefined, limit)

    return apiPaginated(items, nextCursor)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list reports", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list reports", 500)
  }
}

async function post(request: Request) {
  try {
    const body = await request.json()
    const parsed = CreateReportSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, scanId, targetId: requestedTargetId, type, title } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.report.create)

    let resolvedScanId = scanId
    let targetId = requestedTargetId
    if (scanId) {
      const scan = await prisma.scan.findFirst({
        where: { id: scanId, workspaceId, deletedAt: null },
        select: { id: true, targetId: true },
      })
      if (!scan) {
        return apiError("SCAN_NOT_FOUND", "Scan not found in this workspace", 404)
      }
      if (requestedTargetId && scan.targetId !== requestedTargetId) {
        return apiError("SCAN_TARGET_MISMATCH", "Scan does not belong to the requested target", 400)
      }
      targetId = scan.targetId ?? undefined
    } else if (requestedTargetId) {
      const scan = await prisma.scan.findFirst({
        where: {
          workspaceId,
          targetId: requestedTargetId,
          status: "COMPLETED",
          deletedAt: null,
        },
        orderBy: [{ endedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      })
      if (!scan) {
        return apiError(
          "TARGET_SCAN_NOT_FOUND",
          "No completed scan is available for the requested target",
          404
        )
      }
      resolvedScanId = scan.id
    }
    assertOAuthDelegatedScope(session, targetId)

    return await recordedOperation(
      request,
      { workspaceId, operationName: "report.create", input: { ...parsed.data }, session },
      async () => {
        const report = await createReport({
          workspaceId,
          ...(resolvedScanId ? { scanId: resolvedScanId } : {}),
          ...(type ? { type } : {}),
          title,
          createdById: session.userId,
        })

        revalidateDashboardAggregates(workspaceId)

        return apiSuccess(
          {
            id: report.id,
            title: report.title,
            status: report.status,
            snapshotReused: report.snapshotReused === true,
            ...(report.snapshotReused ? { requestedTitle: title } : {}),
          },
          report.snapshotReused ? 200 : 201
        )
      }
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create report", 500)
  }
}

export const POST = withCookieMutation(post)
