import { getShareableReport, generateShareToken, revokeShareToken } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { z } from "zod"

const ReportActionSchema = z.object({
  workspaceId: z.string().min(1),
  action: z.enum(["share", "revoke"]),
})

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.report.download)

    const report = await getShareableReport(id, workspaceId)
    if (!report) {
      return apiError("REPORT_NOT_FOUND", "Report not found", 404)
    }

    return apiSuccess(report)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get report", 500)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = ReportActionSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, action } = parsed.data

    await requirePermission(workspaceId, PERMISSIONS.report.create)

    const report = await getShareableReport(id, workspaceId)
    if (!report) {
      return apiError("REPORT_NOT_FOUND", "Report not found", 404)
    }

    switch (action) {
      case "share": {
        const { token } = await generateShareToken(id)
        return apiSuccess({ token, shareUrl: `/reports/shared/${id}?token=${token}` })
      }
      case "revoke": {
        await revokeShareToken(id)
        return apiSuccess({ revoked: true })
      }
    }
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to update report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update report", 500)
  }
}
