import {
  getShareableReport,
  generateReportHTML,
  gatherReportData,
  prisma,
  type ReportData,
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
      select: { contentJson: true, scanId: true },
    })

    let reportData: ReportData
    if (reportRecord?.contentJson) {
      // Preferred path: serve the immutable snapshot captured at report creation.
      reportData = reportRecord.contentJson as unknown as ReportData
    } else if (reportRecord?.scanId) {
      // Legacy fallback: reports created before the snapshot migration have no
      // contentJson. Regenerate live from the source scan so old reports remain
      // downloadable. These predate snapshotting, so exact-as-reviewed fidelity
      // is not guaranteed — new reports always take the snapshot path above.
      logger.warn("Report has no snapshot; regenerating from source scan (legacy report)", {
        reportId: id,
      })
      reportData = await gatherReportData(workspaceId, reportRecord.scanId)
    } else {
      return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
    }

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
