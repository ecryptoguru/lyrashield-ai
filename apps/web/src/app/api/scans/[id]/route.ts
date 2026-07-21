import { getScanWithEvents, cancelScan } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { z } from "zod"

const WorkspaceSchema = z.string().min(1)

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsedWorkspace = WorkspaceSchema.safeParse(
    new URL(request.url).searchParams.get("workspaceId")
  )

  if (!parsedWorkspace.success) {
    return apiError("MISSING_PARAM", "workspaceId is required", 400)
  }
  const workspaceId = parsedWorkspace.data

  try {
    await requirePermission(workspaceId, PERMISSIONS.scan.view)
    const scan = await getScanWithEvents(id, workspaceId)
    if (!scan) {
      return apiError("SCAN_NOT_FOUND", "Scan not found", 404)
    }

    return apiSuccess(scan)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get scan", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get scan", 500)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }
  const parsed = z.object({ workspaceId: WorkspaceSchema }).safeParse(body)
  if (!parsed.success) {
    return apiError("VALIDATION_ERROR", "workspaceId is required", 400)
  }
  const { workspaceId } = parsed.data

  try {
    await requirePermission(workspaceId, PERMISSIONS.scan.cancel)
    const scan = await getScanWithEvents(id, workspaceId)
    if (!scan) {
      return apiError("SCAN_NOT_FOUND", "Scan not found", 404)
    }

    const cancelled = await cancelScan(id, workspaceId)
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
