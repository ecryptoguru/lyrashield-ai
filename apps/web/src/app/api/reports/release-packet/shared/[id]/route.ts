import {
  getReleasePacket,
  getReleasePacketForDelegatedRead,
  getReportByShareToken,
  ReleasePacketError,
} from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../../lib/api-auth"
import { apiError } from "../../../../../../lib/api-response"
import {
  isReleasePacketExportable,
  releasePacketVerificationContext,
} from "../../../../../../lib/release-packet-verification"

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
    const { session } = await requirePermission(resolved.workspaceId, PERMISSIONS.report.download)

    let result: Awaited<ReturnType<typeof getReleasePacket>>
    try {
      const verification = await releasePacketVerificationContext()
      if (session.oauth?.connectionId) {
        const { connectionId, authorizationVersion, workspaceId: grantWorkspaceId } = session.oauth
        if (!authorizationVersion || grantWorkspaceId !== resolved.workspaceId) {
          return noStore(apiError("FORBIDDEN", "Release packet is not authorized", 403))
        }
        result = await getReleasePacketForDelegatedRead({
          reportId: id,
          workspaceId: resolved.workspaceId,
          userId: session.userId,
          connectionId,
          authorizationVersion,
          shareToken: token,
          ...verification,
        })
      } else {
        result = await getReleasePacket(id, resolved.workspaceId, {
          shareToken: token,
          ...verification,
        })
      }
    } catch (error) {
      if (error instanceof ReleasePacketError && error.code === "SNAPSHOT_INVALID") {
        return noStore(
          apiError("REPORT_SNAPSHOT_MISSING", "Release packet snapshot is unavailable", 409)
        )
      }
      throw error
    }
    if (!result) return noStore(apiError("REPORT_NOT_FOUND", "Release packet not found", 404))
    if (!isReleasePacketExportable(result))
      return noStore(
        apiError(
          "PACKET_AUTHENTICITY_UNAVAILABLE",
          "Release packet authenticity could not be verified",
          409
        )
      )
    return noStore(
      Response.json({
        success: true,
        data: result.payload,
        verification: {
          authenticity: result.authenticity,
          assessmentValidity: result.assessmentValidity,
          currentApplicability: result.currentApplicability,
        },
      })
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return noStore(authErr)
    logger.error("Private release packet read failed", { error: String(error) })
    return noStore(apiError("INTERNAL_ERROR", "Failed to read the release packet", 500))
  }
}
