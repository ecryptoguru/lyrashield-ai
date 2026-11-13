import { recordedOperation } from "@/lib/recorded-operation"
import { withCookieMutation } from "../../../lib/api-auth"
import {
  listReports,
  createReport,
  prisma,
  withDelegatedReadAuthority,
  type DelegatedReadAuthority,
} from "@lyrashield/db"
import { assertOAuthDelegatedScope, requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess, parsePaginationParams } from "../../../lib/api-response"
import { jsonWithEtag } from "../../../lib/http-etag"
import { CreateReportSchema } from "@lyrashield/types"
import { revalidateDashboardAggregates } from "../../../lib/cache"
import {
  delegatedReadPrincipal,
  resolveDelegatedTargetReadScope,
} from "../../../lib/delegated-target-read-scope"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.report.download)
    const { cursor, limit } = parsePaginationParams(searchParams)
    const principal = delegatedReadPrincipal(session, workspace)
    if (principal) {
      return await withDelegatedReadAuthority(principal, async (tx, authority) => {
        const { items, nextCursor } = await listReports(
          workspaceId,
          cursor ?? undefined,
          limit,
          authority.targetIds,
          true,
          tx,
          authority.allowedProfiles
        )
        return jsonWithEtag(request, { items, nextCursor })
      })
    }
    const readScope = await resolveDelegatedTargetReadScope(session, workspace)
    const { items, nextCursor } = await listReports(
      workspaceId,
      cursor ?? undefined,
      limit,
      readScope.targetIds
    )
    return jsonWithEtag(request, { items, nextCursor })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list reports", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list reports", 500)
  }
}

async function resolveReportLockTarget(params: {
  workspaceId: string
  scanId?: string
  requestedTargetId?: string
}) {
  let targetId = params.requestedTargetId
  let profile: string | undefined
  if (!params.scanId) return { targetId, profile }
  const scan = await prisma.scan.findFirst({
    where: { id: params.scanId, workspaceId: params.workspaceId, deletedAt: null },
    select: { id: true, targetId: true, mode: true },
  })
  if (!scan) return apiError("SCAN_NOT_FOUND", "Scan not found in this workspace", 404)
  if (params.requestedTargetId && scan.targetId !== params.requestedTargetId) {
    return apiError("SCAN_TARGET_MISMATCH", "Scan does not belong to the requested target", 400)
  }
  targetId = scan.targetId ?? undefined
  profile = scan.mode
  return { targetId, profile }
}

async function post(request: Request) {
  try {
    const body = await request.json()
    const parsed = CreateReportSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, scanId, targetId: requestedTargetId, type, title } = parsed.data

    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.report.create)
    const principal = delegatedReadPrincipal(session, workspace)

    const lockedTarget = await resolveReportLockTarget({ workspaceId, scanId, requestedTargetId })
    if (lockedTarget instanceof Response) return lockedTarget
    const { targetId: lockTargetId, profile: lockProfile } = lockedTarget

    const execute = async (
      client?: Parameters<typeof createReport>[0]["client"],
      authority?: DelegatedReadAuthority
    ) => {
      let resolvedScanId = scanId
      let targetId = requestedTargetId
      if (principal) {
        if (!lockTargetId || !authority) {
          return apiError(
            "REPORT_TARGET_REQUIRED",
            "A target-bound scan is required for delegated report creation",
            403
          )
        }
        const sourceScan = scanId
          ? await client!.scan.findFirst({
              where: {
                id: scanId,
                workspaceId,
                targetId: lockTargetId,
                deletedAt: null,
                target: { workspaceId, deletedAt: null },
              },
              select: { id: true, targetId: true, mode: true },
            })
          : await client!.scan.findFirst({
              where: {
                workspaceId,
                targetId: lockTargetId,
                status: "COMPLETED",
                deletedAt: null,
                mode: { in: authority.allowedProfiles as never[] },
                target: { workspaceId, deletedAt: null },
              },
              orderBy: [{ endedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
              select: { id: true, targetId: true, mode: true },
            })
        if (!sourceScan) {
          return apiError(
            "TARGET_SCAN_NOT_FOUND",
            "No completed scan is available for the requested target",
            404
          )
        }
        if (!authority.allowedProfiles.includes(sourceScan.mode)) {
          return apiError("FORBIDDEN", "Scan profile is no longer authorized", 403)
        }
        resolvedScanId = sourceScan.id
        targetId = sourceScan.targetId ?? undefined
        assertOAuthDelegatedScope(session, targetId, sourceScan.mode)
      } else {
        const readScope = await resolveDelegatedTargetReadScope(session, workspace, targetId)
        if (readScope.targetIds !== undefined) {
          return apiError("FORBIDDEN", "Delegated target scope is unavailable", 403)
        }
        if (targetId && !resolvedScanId) {
          const scan = await prisma.scan.findFirst({
            where: {
              workspaceId,
              targetId,
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
        } else if (resolvedScanId && !targetId) {
          const scan = await prisma.scan.findFirst({
            where: { id: resolvedScanId, workspaceId, deletedAt: null },
            select: { targetId: true },
          })
          targetId = scan?.targetId ?? undefined
        }
        assertOAuthDelegatedScope(session, targetId)
      }

      return recordedOperation(
        request,
        { workspaceId, operationName: "report.create", input: { ...parsed.data }, session },
        async () => {
          const report = await createReport({
            workspaceId,
            ...(resolvedScanId ? { scanId: resolvedScanId } : {}),
            ...(targetId ? { targetId } : {}),
            requireActiveTarget: Boolean(principal),
            ...(client ? { client } : {}),
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
    }

    // Await inside the try so rejected authority/record writes reach this
    // route's error mapping instead of escaping as unhandled 500s.
    return await (principal
      ? withDelegatedReadAuthority(
          {
            ...principal,
            ...(lockTargetId ? { targetId: lockTargetId } : {}),
            requiredOperation: "report.create",
            ...(lockProfile ? { requiredProfile: lockProfile } : {}),
          },
          (tx, authority) => execute(tx, authority)
        )
      : execute())
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create report", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create report", 500)
  }
}

export const POST = withCookieMutation(post)
