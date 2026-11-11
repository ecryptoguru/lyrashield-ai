import { ReportActionSchema } from "@lyrashield/types"
import { generateReleasePacketShareToken, revokeReleasePacketShareToken } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse, withCookieMutation } from "../../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../../lib/api-response"

const BodySchema = ReportActionSchema.strict()

function privateSuccess(data: Record<string, unknown>) {
  const response = apiSuccess(data)
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

async function post(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const parsed = BodySchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }
    const { workspaceId, action } = parsed.data
    const { session } = await requirePermission(workspaceId, PERMISSIONS.report.create)
    // Report-creation delegation does not consent to managing existing links.
    if (session.oauth) {
      return apiError(
        "FORBIDDEN",
        "Use a browser session or workspace API key to manage this link",
        403
      )
    }

    if (action === "share") {
      const { token, expiresAt } = await generateReleasePacketShareToken(id, workspaceId)
      const query = new URLSearchParams({ token, workspaceId })
      return privateSuccess({
        token,
        expiresAt: expiresAt.toISOString(),
        shareUrl: `/reports/release-packet/shared/${encodeURIComponent(id)}?${query.toString()}`,
      })
    }
    const revokedAt = await revokeReleasePacketShareToken(id, workspaceId)
    return privateSuccess({ revoked: true, revokedAt: revokedAt.toISOString() })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    if (error instanceof Error && error.message === "Report not found") {
      return apiError("REPORT_NOT_FOUND", "Release packet not found", 404)
    }
    logger.error("Release packet link mutation failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update the release packet link", 500)
  }
}

export const POST = withCookieMutation(post)
