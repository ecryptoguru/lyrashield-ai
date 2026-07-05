import { listFixProposals } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiPaginated, parsePaginationParams } from "../../../lib/api-response"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const findingId = searchParams.get("findingId")
    const status = searchParams.get("status")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.finding.view)

    const { cursor, limit } = parsePaginationParams(searchParams)

    const result = await listFixProposals({
      workspaceId,
      ...(findingId ? { findingId } : {}),
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    })

    return apiPaginated(result.items, result.nextCursor)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list fix proposals", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list fix proposals", 500)
  }
}
