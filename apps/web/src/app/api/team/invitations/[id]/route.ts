import { prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { z } from "zod"
import { authErrorResponse } from "@/lib/api-auth"
import { apiError, apiSuccess } from "@/lib/api-response"

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const parsed = z
      .object({ workspaceId: z.string().min(1).max(128), id: z.string().min(1).max(128) })
      .safeParse({
        workspaceId: new URL(request.url).searchParams.get("workspaceId"),
        id: (await context.params).id,
      })
    if (!parsed.success)
      return apiError("VALIDATION_ERROR", "workspaceId and invitation id are required", 400)
    const { workspaceId, id } = parsed.data
    const { session } = await requirePermission(workspaceId, PERMISSIONS.member.invite)
    // Conditional mutation races safely with acceptance: only one can consume pending.
    const revoked = await prisma.invitation.updateMany({
      where: { id, workspaceId, status: "pending" },
      data: { status: "revoked" },
    })
    if (revoked.count !== 1) return apiError("NOT_FOUND", "Pending invitation not found", 404)
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "member.invitation_revoked",
        resourceType: "invitation",
        resourceId: id,
      },
    })
    return apiSuccess({ id })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to revoke invitation", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to revoke invitation", 500)
  }
}
