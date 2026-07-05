import { listReports, createReport } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess, apiPaginated, parsePaginationParams } from "../../../lib/api-response"
import { z } from "zod"

const CreateReportSchema = z.object({
  workspaceId: z.string().min(1),
  scanId: z.string().optional(),
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

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const parsed = CreateReportSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, scanId, type, title } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.report.create)

    const report = await createReport({
      workspaceId,
      ...(scanId ? { scanId } : {}),
      ...(type ? { type } : {}),
      title,
      createdById: session.userId,
    })

    return apiSuccess({ id: report.id, title: report.title, status: report.status }, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create report", 500)
  }
}
