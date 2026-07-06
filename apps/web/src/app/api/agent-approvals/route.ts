import { listApprovals } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiPaginated, parsePaginationParams } from "../../../lib/api-response"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get("workspaceId")
  if (!workspaceId) {
    return apiError("VALIDATION_ERROR", "workspaceId is required", 400)
  }

  const status = url.searchParams.get("status") ?? undefined
  if (status && !["PENDING", "APPROVED", "DENIED", "EXPIRED"].includes(status)) {
    return apiError("VALIDATION_ERROR", "Invalid status filter", 400)
  }

  try {
    await requirePermission(workspaceId, PERMISSIONS.agent.view)
    const { cursor, limit } = parsePaginationParams(url.searchParams)
    const result = await listApprovals({
      workspaceId,
      ...(status ? { status: status as "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    })
    return apiPaginated(result.items, result.nextCursor)
  } catch (err) {
    return authErrorResponse(err)
  }
}
