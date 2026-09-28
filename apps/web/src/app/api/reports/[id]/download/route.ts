import {
  getShareableReport,
  generateLaunchReportHTML,
  generateReportHTML,
  gatherReportData,
  isLaunchReportShareablePayload,
  prisma,
  isReportData,
} from "@lyrashield/db"
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
      select: { contentJson: true, scanId: true, title: true, type: true },
    })

    let html: string
    if (reportRecord?.type === "launch_readiness") {
      if (!isLaunchReportShareablePayload(reportRecord.contentJson)) {
        return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
      }
      html = generateLaunchReportHTML(reportRecord.contentJson)
    } else if (isReportData(reportRecord?.contentJson)) {
      if (
        (reportRecord.scanId === null && reportRecord.contentJson.scanInfo !== null) ||
        (reportRecord.scanId !== null &&
          reportRecord.contentJson.scanInfo?.scanId !== reportRecord.scanId)
      ) {
        return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
      }
      // Preferred path: serve the immutable snapshot captured at report creation.
      html = generateReportHTML(reportRecord.contentJson)
    } else if (reportRecord?.contentJson === null && reportRecord.scanId) {
      // Legacy reports without a stored snapshot can be regenerated from their source scan.
      logger.warn("Report snapshot is unavailable; regenerating from source scan", {
        reportId: id,
      })
      const regenerated = await gatherReportData(workspaceId, reportRecord.scanId)
      if (!isReportData(regenerated) || regenerated.scanInfo?.scanId !== reportRecord.scanId) {
        return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
      }
      html = generateReportHTML(regenerated)
    } else if (reportRecord?.scanId) {
      return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
    } else {
      return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
    }

    await prisma.report
      .update({
        where: { id },
        data: { status: "downloaded" },
      })
      .catch((err) => {
        logger.warn("Failed to update report download status", { reportId: id, error: String(err) })
      })

    const filename = `${reportRecord?.title.replace(/[^\w -]+/g, "").trim() || `report-${id}`}.html`
    const disposition = searchParams.get("download") === "1" ? "attachment" : "inline"

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `${disposition}; filename="${filename}"`,
      },
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to download report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to download report", 500)
  }
}
