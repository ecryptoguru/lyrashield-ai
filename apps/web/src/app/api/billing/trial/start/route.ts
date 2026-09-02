import { withCookieMutation } from "../../../../../lib/api-auth"
import { z } from "zod"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { startTrial } from "@lyrashield/billing"
import { apiError, apiSuccess } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"
import { logger } from "@lyrashield/logger"

const StartTrialSchema = z.object({
  workspaceId: z.string().min(1),
})

/**
 * POST /api/billing/trial/start — start a trial for a workspace.
 *
 * Requires billing.manage permission on the workspace.
 * The durable user claim prevents repeated trials across workspaces even after
 * a membership is removed. Paid workspaces are never downgraded.
 */
async function post(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400)
  }

  const parsed = StartTrialSchema.safeParse(body)
  if (!parsed.success) {
    // A-L09: Don't leak Zod error details to clients
    logger.warn("Trial start validation error", { errors: parsed.error.issues })
    return apiError("VALIDATION_ERROR", "Invalid request body", 400)
  }

  const { workspaceId } = parsed.data

  try {
    // Verify the caller has billing.manage on this workspace
    const { session } = await requirePermission(workspaceId, PERMISSIONS.billing.manage)

    const result = await startTrial(workspaceId, session.userId)

    logger.info("Trial start requested", {
      workspaceId,
      started: result.started,
      trialEndsAt: result.trialEndsAt?.toISOString() ?? null,
    })

    if (!result.started) {
      return apiError(
        result.alreadyUsed ? "TRIAL_ALREADY_USED" : "TRIAL_ALREADY_STARTED",
        result.alreadyUsed
          ? "You have already started a trial on another workspace. Upgrade to continue."
          : "A trial has already been started for this workspace.",
        409
      )
    }

    return apiSuccess({ started: true, trialEndsAt: result.trialEndsAt?.toISOString() }, 200)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message === "TRIAL_PAID_PLAN") {
      return apiError("TRIAL_PAID_PLAN", "Trials are only available on a free workspace.", 409)
    }
    if (error instanceof Error && error.message === "Workspace not found") {
      return apiError("WORKSPACE_NOT_FOUND", "Workspace not found", 404)
    }
    logger.error("Trial start failed", { workspaceId, error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to start trial", 500)
  }
}

export const POST = withCookieMutation(post)
