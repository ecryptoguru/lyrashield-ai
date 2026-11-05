import { getReleasePacket, getReportByShareToken } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../../lib/api-auth"
import { apiError } from "../../../../../../lib/api-response"

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

/**
 * Private release-packet capability. The token narrows the report, but proof of
 * current workspace read authorization remains mandatory. This route is never a
 * public-share equivalent of the signed launch-readiness summary.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const token = new URL(request.url).searchParams.get("token")
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      return noStore(apiError("REPORT_NOT_FOUND", "Release packet not found", 404))
    }
    const resolved = await getReportByShareToken(token)
    if (
      !resolved ||
      resolved.id !== id ||
      !resolved.shareExpiresAt ||
      resolved.shareExpiresAt.getTime() <= Date.now()
    ) {
      return noStore(apiError("REPORT_NOT_FOUND", "Release packet not found", 404))
    }
    await requirePermission(resolved.workspaceId, PERMISSIONS.report.download)
    const payload = await getReleasePacket(id, resolved.workspaceId)
    if (!payload) return noStore(apiError("REPORT_NOT_FOUND", "Release packet not found", 404))
    return noStore(Response.json({ success: true, data: payload }))
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return noStore(authErr)
    logger.error("Private release packet read failed", { error: String(error) })
    return noStore(apiError("INTERNAL_ERROR", "Failed to read the release packet", 500))
  }
}
