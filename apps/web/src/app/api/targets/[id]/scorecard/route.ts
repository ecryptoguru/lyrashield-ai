import { withCookieMutation } from "../../../../../lib/api-auth"
import { createScorecardShare } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"

const Body = z.object({ workspaceId: z.string().min(1) })

async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) return apiError("INVALID_PARAM", "workspaceId is required", 400)
    const { session } = await requirePermission(
      parsed.data.workspaceId,
      PERMISSIONS.scorecard.publish
    )
    const { id } = await params
    const { share, referralCode, shareHandoffs, referredSignups } = await createScorecardShare(
      id,
      parsed.data.workspaceId,
      session.userId
    )
    const publicPayload = share.publicPayload as unknown as { resolvedFindings: number }
    return apiSuccess(
      {
        id: share.id,
        slug: share.slug,
        url: `/score/${share.slug}?ref=${referralCode}`,
        resolvedFindings: publicPayload.resolvedFindings,
        views: share.viewCount,
        shareHandoffs,
        referredSignups,
      },
      201
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message === "No current shareable score for this target") {
      return apiError("SCORE_NOT_SHAREABLE", error.message, 409)
    }
    logger.error("Failed to create scorecard share", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create scorecard share", 500)
  }
}

export const POST = withCookieMutation(post)
