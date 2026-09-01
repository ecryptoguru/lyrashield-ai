import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { evaluateGateForTarget, getLatestGateVerdict } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"

/**
 * GET /api/gate/[targetId]?workspaceId=… — read the latest persisted Launch
 * Gate verdict. Never recomputes; the verdict is an immutable artifact.
 * Staleness is carried on the verdict so consumers can show "re-run the gate".
 */
export async function GET(request: Request, { params }: { params: Promise<{ targetId: string }> }) {
  try {
    const { targetId } = await params
    const workspaceId = new URL(request.url).searchParams.get("workspaceId")
    if (!workspaceId) return apiError("MISSING_PARAM", "workspaceId is required", 400)

    await requirePermission(workspaceId, PERMISSIONS.finding.view)
    const verdict = await getLatestGateVerdict(workspaceId, targetId)
    if (!verdict) {
      return apiError("NOT_EVALUATED", "No gate verdict has been computed for this target yet", 404)
    }
    return apiSuccess(verdict)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to read gate verdict", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to read the gate verdict", 500)
  }
}

/**
 * POST /api/gate/[targetId]?workspaceId=… — evaluate the gate against current
 * evidence and persist a new immutable verdict. Gated to members who can
 * create scans. workspaceId comes from the query string (the same convention
 * as the other workspace-scoped routes); the gate service reads the target
 * under RLS, so a target outside the workspace simply evaluates to not-found.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  try {
    const { targetId } = await params
    const workspaceId = new URL(request.url).searchParams.get("workspaceId")
    if (!workspaceId) return apiError("MISSING_PARAM", "workspaceId is required", 400)

    await requirePermission(workspaceId, PERMISSIONS.scan.create)
    const result = await evaluateGateForTarget(workspaceId, targetId)
    if (!result) return apiError("NOT_FOUND", "Target not found", 404)
    return apiSuccess(result, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to evaluate gate", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to evaluate the gate", 500)
  }
}
