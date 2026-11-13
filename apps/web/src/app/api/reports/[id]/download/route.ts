import {
  getShareableReport,
  getLaunchReportDetail,
  resolveReportDelegationTarget,
  generateLaunchReportHTML,
  generateReportHTML,
  gatherReportData,
  isLaunchReportShareablePayload,
  prisma,
  isReportData,
  reportSnapshotScanBindingMatches,
  withDelegatedReadAuthority,
  type DelegatedReadAuthority,
  type ScopedTransaction,
} from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError } from "../../../../../lib/api-response"
import { notModifiedResponse, representationEtag } from "../../../../../lib/http-etag"
import { delegatedReadPrincipal } from "../../../../../lib/delegated-target-read-scope"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.report.download)
    const principal = delegatedReadPrincipal(session, workspace)
    const load = async (client?: ScopedTransaction, authority?: DelegatedReadAuthority) => {
      const delegated = Boolean(principal)
      if (principal) {
        const delegation = await resolveReportDelegationTarget(id, workspaceId, {
          requireExplicitSnapshotBinding: true,
          allowedProfiles: authority?.allowedProfiles,
          ...(client ? { client } : {}),
        })
        if (!delegation) return apiError("REPORT_NOT_FOUND", "Report not found", 404)
        if (!delegation.targetId) {
          return apiError(
            "REPORT_TARGET_UNAVAILABLE",
            "Report target provenance is unavailable",
            403
          )
        }
        if (
          !authority ||
          !(
            (authority.targetId !== undefined && authority.targetId === delegation.targetId) ||
            authority.targetIds?.includes(delegation.targetId)
          )
        ) {
          return apiError("FORBIDDEN", "Report target is no longer authorized", 403)
        }
        assertOAuthDelegatedScope(session, delegation.targetId)
      }

      const report = await getShareableReport(id, workspaceId, {
        requireExplicitSnapshotBinding: delegated,
        ...(authority ? { allowedProfiles: authority.allowedProfiles } : {}),
        ...(client ? { client } : {}),
      })
      if (!report) {
        return apiError("REPORT_NOT_FOUND", "Report not found", 404)
      }

      const db = client ?? prisma
      const reportRecord = await db.report.findFirst({
        where: { id, workspaceId, deletedAt: null },
        select: { contentJson: true, scanId: true, title: true, type: true },
      })

      let html: string
      if (reportRecord?.type === "launch_readiness") {
        const content: unknown = reportRecord.contentJson
        if (!isLaunchReportShareablePayload(content)) {
          return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
        }
        const launchPayload = content
        const detail = await getLaunchReportDetail(id, workspaceId, client)
        html = generateLaunchReportHTML(launchPayload, { historical: detail?.stale !== false })
      } else if (isReportData(reportRecord?.contentJson)) {
        if (
          !reportRecord ||
          !reportSnapshotScanBindingMatches(
            reportRecord.contentJson,
            reportRecord.scanId,
            reportRecord.type,
            { requireExplicit: delegated }
          )
        ) {
          return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
        }
        html = generateReportHTML(reportRecord.contentJson)
      } else if (reportRecord?.contentJson === null && reportRecord.scanId) {
        if (delegated) {
          return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
        }
        logger.warn("Report snapshot is unavailable; regenerating from source scan", {
          reportId: id,
        })
        const regenerated = await gatherReportData(workspaceId, reportRecord.scanId)
        if (!isReportData(regenerated) || regenerated.scanInfo?.scanId !== reportRecord.scanId) {
          return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
        }
        html = generateReportHTML(regenerated)
      } else {
        return apiError("REPORT_SNAPSHOT_MISSING", "Report snapshot is unavailable", 409)
      }

      await db.report
        .update({
          where: { id },
          data: { status: "downloaded" },
        })
        .catch((err) => {
          logger.warn("Failed to update report download status", {
            reportId: id,
            error: String(err),
          })
        })

      const filename = `${reportRecord?.title.replace(/[^\w -]+/g, "").trim() || `report-${id}`}.html`
      const disposition = searchParams.get("download") === "1" ? "attachment" : "inline"
      const etag = representationEtag(html)
      const notModified = notModifiedResponse(request, etag)
      if (notModified) return notModified

      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `${disposition}; filename="${filename}"`,
          ETag: etag,
        },
      })
    }

    if (principal) {
      return await withDelegatedReadAuthority(principal, (tx, authority) => load(tx, authority))
    }
    return await load()
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to download report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to download report", 500)
  }
}
