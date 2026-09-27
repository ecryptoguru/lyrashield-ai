import { listFixProposals } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { validateFindingScope } from "@lyrashield/db"
import { z } from "zod"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiPaginated, parsePaginationParams } from "../../../lib/api-response"

const FixProposalQuerySchema = z.object({
  workspaceId: z.string().min(1),
  findingId: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  observedInScanId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
})

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const parsed = FixProposalQuerySchema.safeParse(Object.fromEntries(searchParams))
    if (!parsed.success) {
      return apiError(
        "INVALID_PARAM",
        parsed.error.issues[0]?.message ?? "Invalid query parameter",
        400
      )
    }
    const { workspaceId, findingId, targetId, observedInScanId, status } = parsed.data

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

    const { cursor, limit } = parsePaginationParams(searchParams)

    const result = await listFixProposals({
      workspaceId,
      ...(targetId ? { targetId } : {}),
      ...(observedInScanId ? { observedInScanId } : {}),
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
