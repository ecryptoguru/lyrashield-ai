import { getScanQualitySurface, withDelegatedReadAuthority } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError } from "../../../../../lib/api-response"
import { jsonWithEtag } from "../../../../../lib/http-etag"
import { z } from "zod"
import { ScanIdSchema } from "@lyrashield/types"
import { delegatedReadPrincipal, delegatedScanAccess } from "@/lib/delegated-target-read-scope"

const WorkspaceSchema = z.string().min(1)

/**
 * The scan's quality surface: measured facts derived from stored evidence
 * (coverage receipts, verification tiers, manifest, ingestion warnings),
 * labeled heuristics, and the per-surface parity table. Read-only; computed
 * on demand, never persisted over the scan's own evidence.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params
  const parsedId = ScanIdSchema.safeParse(rawId)
  if (!parsedId.success) {
    return apiError("VALIDATION_ERROR", "scan id is required", 400)
  }
  const url = new URL(request.url)
  const parsedWorkspace = WorkspaceSchema.safeParse(url.searchParams.get("workspaceId"))
  if (!parsedWorkspace.success) {
    return apiError("MISSING_PARAM", "workspaceId is required", 400)
  }
  const workspaceId = parsedWorkspace.data

  try {
    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.scan.view)
    const principal = delegatedReadPrincipal(session, workspace)
    const load = async (
      client?: Parameters<typeof getScanQualitySurface>[2],
      authority?: { allowedProfiles: string[] }
    ) => {
      if (principal) {
        const access = await delegatedScanAccess(session, workspace, parsedId.data, client)
        if (!access || access.statusOnly) return null
        return getScanQualitySurface(parsedId.data, workspaceId, client, {
          requireActiveTarget: true,
          allowedProfiles: authority!.allowedProfiles,
        })
      }
      return getScanQualitySurface(parsedId.data, workspaceId)
    }
    const surface = principal
      ? await withDelegatedReadAuthority(principal, (tx, authority) => load(tx, authority))
      : await load()
    if (!surface) {
      return apiError("SCAN_NOT_FOUND", "Scan not found", 404)
    }
    // W2.4: the quality surface is a report representation — ETag on 200 and
    // a bodyless 304 for a matching conditional GET.
    return jsonWithEtag(request, surface)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to compute scan quality surface", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to compute scan quality surface", 500)
  }
}
