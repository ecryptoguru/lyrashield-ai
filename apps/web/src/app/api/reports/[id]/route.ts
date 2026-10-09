import { withCookieMutation } from "../../../../lib/api-auth"
import {
  getShareableReport,
  generateShareToken,
  revokeShareToken,
  getLaunchReportDetail,
  resolveReportDelegationTarget,
} from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { jsonWithEtag } from "../../../../lib/http-etag"
import { ReportActionSchema } from "@lyrashield/types"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const { session } = await requirePermission(workspaceId, PERMISSIONS.report.download)

    const report = await getShareableReport(id, workspaceId)
    if (!report) {
      return apiError("REPORT_NOT_FOUND", "Report not found", 404)
    }
    if (
      session.oauth?.connectionId &&
      session.oauth.scopes.includes("lyrashield.write") &&
      !session.oauth.allTargets
    ) {
      const delegation = await resolveReportDelegationTarget(id, workspaceId)
      if (!delegation) {
        return apiError("REPORT_NOT_FOUND", "Report not found", 404)
      }
      assertOAuthDelegatedScope(session, delegation.targetId)
    }

    // Private issue-time provenance rides along only on this authenticated
    // route — the shared-token reader calls getShareableReport directly and
    // never sees it.
    const launchReport =
      report.type === "launch_readiness" ? await getLaunchReportDetail(id, workspaceId) : null

    // W2.4: ETag bound to the serialized representation — a matching
    // If-None-Match answers 304 with no body.
    return jsonWithEtag(request, launchReport ? { ...report, launchReport } : report)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get report", 500)
  }
}

async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = ReportActionSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, action } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.report.create)

    // Delegated-scope gate (W0.3): share/revoke mutate a report bound to one
    // persisted target, so a narrowed OAuth connection may act only within its
    // grant. The PERSISTED binding is authoritative — a request-body targetId
    // can never steer the check — and an unresolvable binding (workspace-wide
    // scan, deleted scan, legacy/contradictory provenance) fails closed into
    // "requires an all-targets grant" rather than "no check".
    const delegation = await resolveReportDelegationTarget(id, workspaceId)
    if (!delegation) {
      return apiError("REPORT_NOT_FOUND", "Report not found", 404)
    }
    assertOAuthDelegatedScope(session, delegation.targetId)

    switch (action) {
      case "share": {
        const { token, expiresAt } = await generateShareToken(id, workspaceId)
        // tokenHash stays server-side: the client has no legitimate use for the
        // hash of the bearer token it already holds, and echoing it widens the
        // disclosure surface for no feature.
        return apiSuccess({
          token,
          expiresAt: expiresAt.toISOString(),
          shareUrl: `/reports/shared/${id}?token=${token}`,
        })
      }
      case "revoke": {
        const revokedAt = await revokeShareToken(id, workspaceId)
        return apiSuccess({ revoked: true, revokedAt: revokedAt.toISOString() })
      }
    }
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to update report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update report", 500)
  }
}

export const POST = withCookieMutation(post)
