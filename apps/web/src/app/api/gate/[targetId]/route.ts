import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { evaluateGateForTarget, getLatestGateVerdict } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"

/**
 * GET /api/gate/[targetId] — read the latest persisted Launch Gate verdict.
 * Never recomputes; the verdict is an immutable artifact. Staleness is carried
 * on the verdict so consumers can show "re-run the gate" when it is stale.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  try {
    const { targetId } = await params
    const verdict = await getLatestGateVerdictForRequest(targetId)
    if (verdict === null) return apiError("NOT_FOUND", "Target not found", 404)
    if (verdict === undefined) {
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
 * POST /api/gate/[targetId] — evaluate the gate against current evidence and
 * persist a new immutable verdict. Approval-gated to members who can run scans.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ targetId: string }> }
) {
  try {
    const { targetId } = await params
    const result = await evaluateGateForTargetRequest(targetId)
    if (!result) return apiError("NOT_FOUND", "Target not found", 404)
    return apiSuccess(result, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to evaluate gate", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to evaluate the gate", 500)
  }
}

// ─── helpers (kept thin; permission + workspace resolution live here) ────────

async function resolveWorkspaceForTarget(targetId: string): Promise<string | null> {
  // We only need the workspaceId to scope the permission check and the RLS
  // gate reads; the gate service then re-reads the target under RLS.
  const target = await prisma.target.findUnique({
    where: { id: targetId },
    select: { workspaceId: true },
  })
  return target?.workspaceId ?? null
}

async function getLatestGateVerdictForRequest(targetId: string) {
  const workspaceId = await resolveWorkspaceForTarget(targetId)
  if (!workspaceId) return null
  await requirePermission(workspaceId, PERMISSIONS.finding.view)
  const verdict = await getLatestGateVerdict(workspaceId, targetId)
  return verdict ?? undefined
}

async function evaluateGateForTargetRequest(targetId: string) {
  const workspaceId = await resolveWorkspaceForTarget(targetId)
  if (!workspaceId) return null
  await requirePermission(workspaceId, PERMISSIONS.scan.create)
  return evaluateGateForTarget(workspaceId, targetId)
}
