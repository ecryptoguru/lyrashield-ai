import { withCookieMutation } from "../../../../lib/api-auth"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { evaluateGateForTarget, getCurrentGateVerdict } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { z } from "zod"

const GateQuerySchema = z
  .object({
    workspaceId: z.string().min(1),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/i)
      .optional(),
    artifactDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/i)
      .optional(),
  })
  .refine((value) => !(value.commit && value.artifactDigest), {
    message: "commit and artifactDigest are mutually exclusive",
  })

/**
 * GET /api/gate/[targetId]?workspaceId=… — read the latest persisted Launch
 * Gate verdict. Never recomputes; the verdict is an immutable artifact.
 * Staleness is carried on the verdict so consumers can show "re-run the gate".
 */
export async function GET(request: Request, { params }: { params: Promise<{ targetId: string }> }) {
  try {
    const { targetId } = await params
    const searchParams = new URL(request.url).searchParams
    const parsed = GateQuerySchema.safeParse({
      workspaceId: searchParams.get("workspaceId"),
      commit: searchParams.get("commit") ?? undefined,
      artifactDigest: searchParams.get("artifactDigest") ?? undefined,
    })
    if (!parsed.success) {
      return apiError(
        "INVALID_PARAM",
        parsed.error.issues[0]?.message ?? "Invalid gate request",
        400
      )
    }
    const { workspaceId, commit, artifactDigest } = parsed.data

    await requirePermission(workspaceId, PERMISSIONS.finding.view)
    const verdict = await getCurrentGateVerdict(workspaceId, targetId, {
      expectedCommit: commit,
      expectedArtifactDigest: artifactDigest,
    })
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
async function post(request: Request, { params }: { params: Promise<{ targetId: string }> }) {
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

export const POST = withCookieMutation(post)
