import {
  generateReleasePacketCsv,
  getReleasePacket,
  getReleasePacketForDelegatedRead,
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

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const format = searchParams.get("format") ?? "csv"
    if (!workspaceId) return apiError("MISSING_PARAM", "workspaceId is required", 400)
    if (format !== "csv") return apiError("UNSUPPORTED_FORMAT", "Only CSV is available here", 400)
    const { session } = await requirePermission(workspaceId, PERMISSIONS.report.download)

    let result: Awaited<ReturnType<typeof getReleasePacket>>
    try {
      const verification = await releasePacketVerificationContext()
      if (session.oauth?.connectionId) {
        const { connectionId, authorizationVersion, workspaceId: grantWorkspaceId } = session.oauth
        if (!authorizationVersion || grantWorkspaceId !== workspaceId) {
          return apiError("FORBIDDEN", "Release packet is not authorized", 403)
        }
        result = await getReleasePacketForDelegatedRead({
          reportId: id,
          workspaceId,
          userId: session.userId,
          connectionId,
          authorizationVersion,
          ...verification,
        })
      } else {
        result = await getReleasePacket(id, workspaceId, verification)
      }
    } catch (error) {
      if (error instanceof ReleasePacketError && error.code === "SNAPSHOT_INVALID") {
        return apiError("REPORT_SNAPSHOT_MISSING", "Release packet snapshot is unavailable", 409)
      }
      throw error
    }
    if (!result) return apiError("REPORT_NOT_FOUND", "Release packet not found", 404)
    if (!isReleasePacketExportable(result))
      return apiError(
        "PACKET_AUTHENTICITY_UNAVAILABLE",
        "Release packet authenticity could not be verified",
        409
      )
    const csv = generateReleasePacketCsv(result.payload, result)
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="release-packet-${id.replace(/[^a-zA-Z0-9_-]/g, "")}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Release packet CSV failed", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to export the release packet", 500)
  }
}
