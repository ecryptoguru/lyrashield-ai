import { revokeScorecardShare } from "@lyrashield/db"
import { requireWorkspaceAccess } from "@lyrashield/auth/server"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"

const Body = z.object({ workspaceId: z.string().min(1) })
const PUBLISHERS = new Set(["OWNER", "ADMIN", "SECURITY_ADMIN", "APPSEC_MANAGER"])

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) return apiError("INVALID_PARAM", "workspaceId is required", 400)
    const { session, workspace } = await requireWorkspaceAccess(parsed.data.workspaceId)
    if (!PUBLISHERS.has(workspace.role)) throw new Error("FORBIDDEN")
    const { id } = await params
    const share = await revokeScorecardShare(id, parsed.data.workspaceId, session.userId)
    if (!share) return apiError("SCORECARD_NOT_FOUND", "Scorecard not found", 404)
    return apiSuccess({ revoked: true })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to revoke scorecard share", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to revoke scorecard share", 500)
  }
}
