import { getAiSecurityScoreSnapshot } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../../lib/api-auth"
import { apiError } from "../../../../../lib/api-response"
import { z } from "zod"
import { NextResponse } from "next/server"

const WorkspaceSchema = z.string().min(1)

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsedWorkspace = WorkspaceSchema.safeParse(
    new URL(request.url).searchParams.get("workspaceId")
  )

  if (!parsedWorkspace.success) {
    return apiError("MISSING_PARAM", "workspaceId is required", 400)
  }

  const workspaceId = parsedWorkspace.data

  try {
    await requirePermission(workspaceId, PERMISSIONS.scan.view)
    const snapshot = await getAiSecurityScoreSnapshot(id, workspaceId)

    if (!snapshot) {
      return NextResponse.json(
        { success: true, data: { score: null } },
        { headers: { "Cache-Control": "private, no-store" } }
      )
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          score: snapshot.score,
          methodology: snapshot.methodology,
          assessedCount: snapshot.assessedCount,
          totalControls: snapshot.totalControls,
          evidenceQuality: snapshot.evidenceQuality,
          breakdown: snapshot.breakdown,
          reason: (snapshot.breakdown as Record<string, unknown>)?.reason,
          computedAt: snapshot.computedAt,
          shareEligible: false,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } }
    )
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get AI security score snapshot", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get AI security score snapshot", 500)
  }
}
