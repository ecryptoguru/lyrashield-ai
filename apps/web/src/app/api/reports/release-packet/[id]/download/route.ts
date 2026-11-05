import { getReleasePacket, generateReleasePacketCsv } from "@lyrashield/db"
import { ReleasePacketPayloadSchema } from "@lyrashield/types"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../../lib/api-auth"
import { apiError } from "../../../../../../lib/api-response"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const format = searchParams.get("format") ?? "csv"
    if (!workspaceId) return apiError("MISSING_PARAM", "workspaceId is required", 400)
    if (format !== "csv") return apiError("UNSUPPORTED_FORMAT", "Only CSV is available here", 400)
    const { session } = await requirePermission(workspaceId, PERMISSIONS.report.download)
    const payload = await getReleasePacket(id, workspaceId)
    if (!payload) return apiError("REPORT_NOT_FOUND", "Release packet not found", 404)
    const parsed = ReleasePacketPayloadSchema.safeParse(payload)
    if (!parsed.success) {
      logger.error("Release packet CSV snapshot invalid", {
        reportId: id,
        userId: session.userId,
      })
      return apiError("REPORT_SNAPSHOT_MISSING", "Release packet snapshot is unavailable", 409)
    }
    const csv = generateReleasePacketCsv(parsed.data)
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
