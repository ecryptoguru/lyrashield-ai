import { getShareableReport, generateReportHTML, prisma, type ReportData } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError } from "../../../../../lib/api-response"

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

    const reportRecord = await prisma.report.findFirst({
      where: { id, workspaceId, deletedAt: null },
      select: { contentJson: true },
    })

    if (!reportRecord?.contentJson) {
      return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
    }
    const reportData = reportRecord.contentJson as unknown as ReportData

    const html = generateReportHTML(reportData)

    await prisma.report
      .update({
        where: { id },
        data: { status: "downloaded" },
      })
      .catch((err) => {
        logger.warn("Failed to update report download status", { reportId: id, error: String(err) })
      })

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="report-${id}.html"`,
      },
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to download report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to download report", 500)
  }
}
