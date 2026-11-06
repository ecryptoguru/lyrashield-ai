import { withCookieMutation } from "../../../../lib/api-auth"
import {
  getShareableReport,
  generateShareToken,
  revokeShareToken,
  getLaunchReportDetail,
  resolveReportDelegationTarget,
  withDelegatedReadAuthority,
  type DelegatedReadAuthority,
  type ScopedTransaction,
} from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { jsonWithEtag } from "../../../../lib/http-etag"
import { ReportActionSchema } from "@lyrashield/types"
import { delegatedReadPrincipal } from "../../../../lib/delegated-target-read-scope"

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

    const load = async (
      client?: Parameters<typeof getShareableReport>[2] extends infer T
        ? T extends { client?: infer C }
          ? C
          : never
        : never,
      authority?: DelegatedReadAuthority
    ) => {
      const delegated = Boolean(principal)
      if (principal) {
        const delegation = await resolveReportDelegationTarget(id, workspaceId, {
          requireExplicitSnapshotBinding: true,
          allowedProfiles: authority?.allowedProfiles,
          ...(client ? { client } : {}),
        })
        if (!delegation) {
          return apiError("REPORT_NOT_FOUND", "Report not found", 404)
        }
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

      const launchReport =
        report.type === "launch_readiness"
          ? await getLaunchReportDetail(id, workspaceId, client)
          : null
      return jsonWithEtag(request, launchReport ? { ...report, launchReport } : report)
    }

    if (principal) {
      return await withDelegatedReadAuthority(principal, (tx, authority) => load(tx, authority))
    }
    return load()
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

    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.report.create)

    const principal = delegatedReadPrincipal(session, workspace)
    const mutate = async (client?: ScopedTransaction, authority?: DelegatedReadAuthority) => {
      const delegated = Boolean(principal)
      const delegation = await resolveReportDelegationTarget(id, workspaceId, {
        requireExplicitSnapshotBinding: delegated,
        ...(authority ? { allowedProfiles: authority.allowedProfiles } : {}),
        ...(client ? { client } : {}),
      })
      if (!delegation) {
        return apiError("REPORT_NOT_FOUND", "Report not found", 404)
      }
      if (!delegation.targetId) {
        return apiError("REPORT_TARGET_UNAVAILABLE", "Report target provenance is unavailable", 403)
      }
      if (
        principal &&
        (!authority ||
          !(
            (authority.targetId !== undefined && authority.targetId === delegation.targetId) ||
            authority.targetIds?.includes(delegation.targetId)
          ))
      ) {
        return apiError("FORBIDDEN", "Report target is no longer authorized", 403)
      }
      assertOAuthDelegatedScope(session, delegation.targetId)

      switch (action) {
        case "share": {
          const { token, expiresAt } = await generateShareToken(id, workspaceId, {
            targetId: delegation.targetId,
            requireActiveTarget: delegated,
            ...(client ? { client } : {}),
          })
          return apiSuccess({
            token,
            expiresAt: expiresAt.toISOString(),
            shareUrl: `/reports/shared/${id}?token=${token}`,
          })
        }
        case "revoke": {
          const revokedAt = await revokeShareToken(id, workspaceId, {
            targetId: delegation.targetId,
            requireActiveTarget: delegated,
            ...(client ? { client } : {}),
          })
          return apiSuccess({ revoked: true, revokedAt: revokedAt.toISOString() })
        }
      }
    }

    if (principal) {
      return await withDelegatedReadAuthority(
        { ...principal, requiredOperation: "report.create" },
        (tx, authority) => mutate(tx, authority)
      )
    }
    return mutate()
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to update report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update report", 500)
  }
}

export const POST = withCookieMutation(post)
