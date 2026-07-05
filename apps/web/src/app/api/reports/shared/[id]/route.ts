import { getReportByShareToken, getShareableReport } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "../../../../../lib/api-response"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get("token")

    if (!token) {
      return apiError("MISSING_PARAM", "Share token is required", 400)
    }

    const report = await getReportByShareToken(token)
    if (!report || report.id !== id) {
      return apiError("REPORT_NOT_FOUND", "Report not found or share link expired", 404)
    }

    const shareable = await getShareableReport(report.id, report.workspaceId)
    if (!shareable) {
      return apiError("REPORT_NOT_FOUND", "Report not found", 404)
    }

    return apiSuccess(shareable)
  } catch (error) {
    logger.error("Failed to get shared report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get report", 500)
  }
}
