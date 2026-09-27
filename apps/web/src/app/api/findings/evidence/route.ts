import { listEvidenceFindings, validateFindingScope } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiPaginated, parsePaginationParams } from "../../../../lib/api-response"

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
    await requirePermission(workspaceId, PERMISSIONS.finding.view)

    const scope = await validateFindingScope({
      workspaceId,
      ...(targetId ? { targetId } : {}),
      ...(observedInScanId ? { observedInScanId } : {}),
    })
    if (!scope.available) {
      return apiError(
        "INVALID_PARAM",
        "Selected scan or target is unavailable in this workspace",
        400
      )
    }

    const { cursor, limit } = parsePaginationParams(searchParams, 25)
    const result = await listEvidenceFindings({
      workspaceId,
      ...(targetId ? { targetId } : {}),
      ...(observedInScanId ? { observedInScanId } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    })

    return apiPaginated(result.items, result.nextCursor)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list finding evidence", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list evidence", 500)
  }
}
