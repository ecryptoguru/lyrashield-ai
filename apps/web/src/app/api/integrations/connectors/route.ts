import { listConnectorConnections } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { z } from "zod"

export const dynamic = "force-dynamic"

/**
 * Workspace connector connections (GitHub App installations, Slack OAuth
 * connections). The projection is deliberately safe: id/type/name/status/
 * scope — never configRef or credential material.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = z.string().min(1).safeParse(searchParams.get("workspaceId"))
    if (!workspaceId.success) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }
    await requirePermission(workspaceId.data, PERMISSIONS.integration.manage)
    const connections = await listConnectorConnections(workspaceId.data)
    return apiSuccess(connections)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list connector connections", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list connector connections", 500)
  }
}
