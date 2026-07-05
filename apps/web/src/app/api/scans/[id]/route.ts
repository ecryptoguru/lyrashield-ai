import { getScanWithEvents, cancelScan } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const scan = await getScanWithEvents(id)
    if (!scan) {
      return apiError("SCAN_NOT_FOUND", "Scan not found", 404)
    }

    await requirePermission(scan.workspaceId, PERMISSIONS.scan.view)

    return apiSuccess(scan)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get scan", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get scan", 500)
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const scan = await getScanWithEvents(id)
    if (!scan) {
      return apiError("SCAN_NOT_FOUND", "Scan not found", 404)
    }

    await requirePermission(scan.workspaceId, PERMISSIONS.scan.cancel)

    const cancelled = await cancelScan(id)
    return apiSuccess({
      id: cancelled.id,
      status: cancelled.status,
      endedAt: cancelled.endedAt,
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message.includes("terminal state")) {
      return apiError("SCAN_ALREADY_FINISHED", error.message, 409)
    }
    logger.error("Failed to cancel scan", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to cancel scan", 500)
  }
}
