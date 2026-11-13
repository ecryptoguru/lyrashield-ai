import {
  listEvidenceFindings,
  validateFindingScope,
  withDelegatedReadAuthority,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiPaginated, parsePaginationParams } from "../../../../lib/api-response"
import {
  delegatedReadPrincipal,
  resolveDelegatedTargetReadScope,
} from "../../../../lib/delegated-target-read-scope"

const EvidenceQuerySchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1).optional(),
  observedInScanId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.string().optional(),
})

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const parsed = EvidenceQuerySchema.safeParse(Object.fromEntries(searchParams))
    if (!parsed.success) {
      return apiError(
        "INVALID_PARAM",
        parsed.error.issues[0]?.message ?? "Invalid query parameter",
        400
      )
    }

    const { workspaceId, targetId, observedInScanId } = parsed.data
    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.finding.view)
    const principal = delegatedReadPrincipal(session, workspace)
    const load = async (
      client?: Parameters<typeof listEvidenceFindings>[1],
      authority?: { targetId?: string; targetIds?: string[]; allowedProfiles: string[] }
    ) => {
      const readScope = authority
        ? {
            ...(authority.targetId ? { targetId: authority.targetId } : {}),
            ...(authority.targetIds !== undefined ? { targetIds: authority.targetIds } : {}),
            allowedProfiles: authority.allowedProfiles,
            requireActiveTarget: true,
          }
        : await resolveDelegatedTargetReadScope(session, workspace, targetId)
      const scopeInput = {
        workspaceId,
        ...readScope,
        ...(observedInScanId ? { observedInScanId } : {}),
      }
      const scope = client
        ? await validateFindingScope(scopeInput, client)
        : await validateFindingScope(scopeInput)
      if (!scope.available) return null

      const { cursor, limit } = parsePaginationParams(searchParams, 25)
      const listInput = {
        workspaceId,
        ...readScope,
        ...(observedInScanId ? { observedInScanId } : {}),
        ...(cursor ? { cursor } : {}),
        limit,
      }
      return client ? listEvidenceFindings(listInput, client) : listEvidenceFindings(listInput)
    }
    const result = principal
      ? await withDelegatedReadAuthority(
          { ...principal, ...(targetId ? { targetId } : {}) },
          (tx, authority) => load(tx, authority)
        )
      : await load()
    if (!result) {
      return apiError(
        "INVALID_PARAM",
        "Selected scan or target is unavailable in this workspace",
        400
      )
    }

    return apiPaginated(result.items, result.nextCursor)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list finding evidence", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list evidence", 500)
  }
}
