import { createScorecardShare } from "@lyrashield/db"
import { requireWorkspaceAccess } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"

const Body = z.object({ workspaceId: z.string().min(1) })
const PUBLISHERS = new Set(["OWNER", "ADMIN", "SECURITY_ADMIN", "APPSEC_MANAGER"])

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) return apiError("INVALID_PARAM", "workspaceId is required", 400)
    const { session, workspace } = await requireWorkspaceAccess(parsed.data.workspaceId)
    if (!PUBLISHERS.has(workspace.role)) throw new Error("FORBIDDEN")
    const { id } = await params
    const { share, referralCode } = await createScorecardShare(
      id,
      parsed.data.workspaceId,
      session.userId
    )
    return apiSuccess(
      { id: share.id, slug: share.slug, url: `/score/${share.slug}?ref=${referralCode}` },
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
