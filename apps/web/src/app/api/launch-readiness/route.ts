import { listFindings } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../lib/api-response"
import { logger } from "@lyrashield/logger"
import { generateLaunchReadinessReport, type FindingForReadiness } from "@/lib/launch-readiness"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const targetId = searchParams.get("targetId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.finding.view)

    const { items } = await listFindings({
      workspaceId,
      ...(targetId ? { targetId } : {}),
      limit: 100,
    })

    const findings: FindingForReadiness[] = items.map((f) => ({
      id: f.id,
      severity: f.severity,
      status: f.status,
      verified: f.verified,
      confidence: f.confidence,
      category: f.category,
      cwe: f.cwe,
      title: f.title,
      summary: f.summary ?? "",
    }))

    const report = generateLaunchReadinessReport(findings)

    return apiSuccess(report)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get launch readiness", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get launch readiness report", 500)
  }
}
