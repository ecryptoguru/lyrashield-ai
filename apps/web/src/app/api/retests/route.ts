import { listRetests, withDelegatedReadAuthority } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiPaginated, parsePaginationParams } from "../../../lib/api-response"
import { delegatedReadPrincipal } from "../../../lib/delegated-target-read-scope"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const findingId = searchParams.get("findingId")
    const status = searchParams.get("status")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const { session, workspace } = await requirePermission(workspaceId, PERMISSIONS.retest.view)
    const principal = delegatedReadPrincipal(session, workspace)
    const load = async (
      client?: Parameters<typeof listRetests>[1],
      authority?: { targetId?: string; targetIds?: string[]; allowedProfiles: string[] }
    ) => {
      const readScope = authority
        ? {
            ...(authority.targetId ? { targetId: authority.targetId } : {}),
            ...(authority.targetIds !== undefined ? { targetIds: authority.targetIds } : {}),
            allowedProfiles: authority.allowedProfiles,
            requireActiveTarget: true,
          }
        : {}
      const { cursor, limit } = parsePaginationParams(searchParams)
      const listInput = {
        workspaceId,
        ...readScope,
        ...(findingId ? { findingId } : {}),
        ...(status ? { status } : {}),
        ...(cursor ? { cursor } : {}),
        limit,
      }
      return client ? listRetests(listInput, client) : listRetests(listInput)
    }
    const result = principal
      ? await withDelegatedReadAuthority(principal, (tx, authority) => load(tx, authority))
      : await load()
    return apiPaginated(result.items, result.nextCursor)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list retests", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list retests", 500)
  }
}
