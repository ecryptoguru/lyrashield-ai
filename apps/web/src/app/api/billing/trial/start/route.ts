import { z } from "zod"
import { prisma } from "@lyrashield/db"
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
 * Prevents trial abuse across workspaces: if the user already has a workspace
 * with trialStartedAt != null, the request is rejected.
 */
export async function POST(request: Request) {
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

    // Prevent trial abuse across workspaces: check if the user already has
    // any workspace with a trial already started.
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: session.userId },
      select: { workspaceId: true },
    })
    const workspaceIds = memberships.map((m) => m.workspaceId)

    if (workspaceIds.length > 0) {
      const existingTrial = await prisma.workspace.findFirst({
        where: {
          id: { in: workspaceIds },
          trialStartedAt: { not: null },
        },
        select: { id: true, trialStartedAt: true },
      })

      if (existingTrial) {
        return apiError(
          "TRIAL_ALREADY_USED",
          "You have already started a trial on another workspace. Upgrade to continue.",
          409
        )
      }
    }

    const result = await startTrial(workspaceId)

    logger.info("Trial start requested", {
      workspaceId,
      started: result.started,
      trialEndsAt: result.trialEndsAt.toISOString(),
    })

    if (!result.started) {
      return apiError(
        "TRIAL_ALREADY_STARTED",
        "A trial has already been started for this workspace.",
        409
      )
    }

    return apiSuccess(
      { started: true, trialEndsAt: result.trialEndsAt.toISOString() },
      200
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message === "Workspace not found") {
      return apiError("WORKSPACE_NOT_FOUND", "Workspace not found", 404)
    }
    logger.error("Trial start failed", { workspaceId, error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to start trial", 500)
  }
}
