import { listScans, withDelegatedReadAuthority } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { MAX_CONCURRENT_WORKSPACE_SCANS, ScanStatusSchema } from "@lyrashield/types"
import { NextResponse } from "next/server"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, parsePaginationParams } from "../../../lib/api-response"
import { parseScanStateFilter, scanStateStatuses } from "@/lib/scan-presentation"
import { delegatedReadPrincipal } from "../../../lib/delegated-target-read-scope"
import { projectDelegatedScanList } from "../../../lib/delegated-scan-list-projection"
import { serializeScanListItem, scanListEtag, ScanIdQuerySchema } from "./scan-list-response"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const targetId = searchParams.get("targetId")
    const rawStatus = searchParams.get("status")
    const rawScanIds = searchParams.get("ids")
    const stateFilter = parseScanStateFilter(searchParams.get("state"))
    if (!workspaceId) return apiError("MISSING_PARAM", "workspaceId is required", 400)

    let scanIds: string[] | undefined
    if (rawScanIds !== null) {
      const parsed = ScanIdQuerySchema.safeParse(rawScanIds.split(",").map((id) => id.trim()))
      if (!parsed.success) {
        return apiError(
          "INVALID_PARAM",
          `ids must contain 1-${MAX_CONCURRENT_WORKSPACE_SCANS} valid scan IDs`,
          400
        )
      }
      scanIds = parsed.data
    }

    let statusFilter: Parameters<typeof listScans>[0]["statuses"] | undefined
    let singleStatus: Parameters<typeof listScans>[0]["status"] | undefined
    if (rawStatus) {
      const parts = rawStatus
        .split(",")
        .map((status) => status.trim())
        .filter(Boolean)
      if (parts.length > 1) {
        const parsed = parts.map((status) => ScanStatusSchema.safeParse(status))
        if (parsed.some((result) => !result.success)) {
          return apiError("INVALID_PARAM", "status contains an invalid scan status value", 400)
        }
        statusFilter = parsed.map(
          (result) => (result as { success: true; data: typeof singleStatus }).data!
        )
      } else {
        const parsed = ScanStatusSchema.safeParse(parts[0])
        if (!parsed.success)
          return apiError("INVALID_PARAM", "status must be a valid scan status", 400)
        singleStatus = parsed.data
      }
    }

    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.scan.view)
    const principal = delegatedReadPrincipal(session, workspace)
    const { cursor, limit } = parsePaginationParams(searchParams, 25)
    const stateStatuses = scanStateStatuses(stateFilter)
    const explicitStatuses = statusFilter ?? (singleStatus ? [singleStatus] : undefined)
    let effectiveStatuses: string[] | undefined
    if (stateStatuses && explicitStatuses) {
      effectiveStatuses = explicitStatuses.filter((status) => stateStatuses.includes(status))
      if (effectiveStatuses.length === 0) {
        return NextResponse.json(
          { success: true, data: { items: [], nextCursor: null } },
          { status: 200, headers: { "Cache-Control": "private, no-store" } }
        )
      }
    } else if (stateStatuses) {
      effectiveStatuses = stateStatuses
    }

    const load = async (
      client?: Parameters<typeof listScans>[1],
      authority?: { targetId?: string; targetIds?: string[]; allowedProfiles: string[] }
    ) => {
      const readScope = authority
        ? {
            ...(authority.targetId ? { targetId: authority.targetId } : {}),
            ...(authority.targetIds !== undefined ? { targetIds: authority.targetIds } : {}),
            allowedProfiles: authority.allowedProfiles,
            requireActiveTarget: true,
          }
        : targetId
          ? { targetId }
          : {}
      const listInput = {
        workspaceId,
        ...(scanIds ? { scanIds } : {}),
        ...readScope,
        ...(effectiveStatuses
          ? { statuses: effectiveStatuses as Parameters<typeof listScans>[0]["statuses"] }
          : statusFilter
            ? { statuses: statusFilter }
            : singleStatus
              ? { status: singleStatus }
              : {}),
        ...(cursor ? { cursor } : {}),
        limit,
      }
      const page = client ? await listScans(listInput, client) : await listScans(listInput)
      return {
        ...page,
        items: client
          ? await projectDelegatedScanList(session, workspace, page.items, client)
          : page.items.map(serializeScanListItem),
      }
    }
    const { items: serialized, nextCursor } = principal
      ? await withDelegatedReadAuthority(
          { ...principal, ...(targetId ? { targetId } : {}) },
          (tx, authority) => load(tx, authority)
        )
      : await load()
    const etag = scanListEtag(serialized, nextCursor)
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }
    return NextResponse.json(
      { success: true, data: { items: serialized, nextCursor } },
      { status: 200, headers: { ETag: etag } }
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list scans", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list scans", 500)
  }
}
