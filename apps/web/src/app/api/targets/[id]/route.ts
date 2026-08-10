import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { PatchApiSpecSchema } from "@lyrashield/types"
import { logger } from "@lyrashield/logger"
import { checkScanUrlSafe } from "../../../../lib/ssrf"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError } from "../../../../lib/api-response"

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: "INVALID_JSON", message: "Request body must be valid JSON" },
      },
      { status: 400 }
    )
  }

  const parsed = PatchApiSpecSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
      { status: 400 }
    )
  }

  const { workspaceId, apiSpecUrl } = parsed.data
  const { id } = await params

  try {
    const { session } = await requirePermission(workspaceId, PERMISSIONS.target.update)

    const target = await prisma.target.findFirst({
      where: { id, workspaceId, deletedAt: null },
    })
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found in this workspace", 404)
    }
    if (target.type !== "API") {
      return apiError("INVALID_TARGET_TYPE", "OpenAPI URL can only be set on API targets", 400)
    }

    if (apiSpecUrl) {
      const ssrf = await checkScanUrlSafe(apiSpecUrl)
      if (!ssrf.safe) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "SSRF_BLOCKED",
              message:
                "This OpenAPI URL is not allowed (it targets an internal, private, or unresolvable address).",
            },
          },
          { status: 400 }
        )
      }
    }

    const updated = await prisma.target.update({
      where: { id },
      data: { apiSpecUrl },
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "target.api_spec_updated",
        resourceType: "target",
        resourceId: target.id,
        metadata: { apiSpecUrl: apiSpecUrl ?? null },
      },
    })

    logger.info("Target OpenAPI URL updated", { targetId: target.id, workspaceId })

    return NextResponse.json({
      success: true,
      data: {
        id: updated.id,
        type: updated.type,
        apiSpecUrl: updated.apiSpecUrl,
      },
    })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to update target OpenAPI URL", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update target OpenAPI URL", 500)
  }
}
