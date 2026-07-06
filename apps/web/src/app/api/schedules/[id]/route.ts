import { getSchedule, updateSchedule, deleteSchedule, getNextRunAt, prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../../lib/api-auth"
import { apiError, apiSuccess } from "../../../../lib/api-response"
import { z } from "zod"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.schedule.view)

    const schedule = await getSchedule(id, workspaceId)
    if (!schedule) {
      return apiError("SCHEDULE_NOT_FOUND", "Schedule not found", 404)
    }

    return apiSuccess(schedule)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to get schedule", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to get schedule", 500)
  }
}

const PatchScheduleSchema = z.object({
  workspaceId: z.string().min(1),
  cron: z
    .string()
    .min(1)
    .refine(
      (c) => getNextRunAt(c.trim()) !== null,
      "Use a five-field schedule like '0 0 * * 0' or '30 8 * * *'"
    )
    .optional(),
  goal: z.enum(["CHECK_PR", "TEST_APP", "LAUNCH_REVIEW", "WEEKLY_MONITOR", "FULL_PENTEST", "COMPLIANCE_REVIEW"]).optional(),
  mode: z.enum(["SAFE", "QUICK", "STANDARD", "DEEP"]).optional(),
  enabled: z.boolean().optional(),
})

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const body = await request.json()
    const parsed = PatchScheduleSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, ...updateData } = parsed.data
    if (updateData.cron) updateData.cron = updateData.cron.trim()

    const { session } = await requirePermission(workspaceId, PERMISSIONS.schedule.update)

    const schedule = await getSchedule(id, workspaceId)
    if (!schedule) {
      return apiError("SCHEDULE_NOT_FOUND", "Schedule not found", 404)
    }

    const updated = await updateSchedule(id, workspaceId, updateData)

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "schedule.updated",
        resourceType: "schedule",
        resourceId: id,
      },
    })

    return apiSuccess({ id: updated.id, enabled: updated.enabled, cron: updated.cron })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to update schedule", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to update schedule", 500)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    const { session } = await requirePermission(workspaceId, PERMISSIONS.schedule.delete)

    const schedule = await getSchedule(id, workspaceId)
    if (!schedule) {
      return apiError("SCHEDULE_NOT_FOUND", "Schedule not found", 404)
    }

    await deleteSchedule(id, workspaceId)

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "schedule.deleted",
        resourceType: "schedule",
        resourceId: id,
      },
    })

    return apiSuccess({ id, deleted: true })
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to delete schedule", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to delete schedule", 500)
  }
}
