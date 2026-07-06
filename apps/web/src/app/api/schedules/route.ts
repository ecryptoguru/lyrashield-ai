import { listSchedules, createSchedule, getNextRunAt, prisma } from "@lyrashield/db"
import { requirePermission } from "@lyrashield/auth/server"
import { PERMISSIONS } from "@lyrashield/auth"
import { logger } from "@lyrashield/logger"
import { authErrorResponse } from "../../../lib/api-auth"
import { apiError, apiSuccess, apiPaginated, parsePaginationParams } from "../../../lib/api-response"
import { z } from "zod"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const workspaceId = searchParams.get("workspaceId")
    const targetId = searchParams.get("targetId")
    const enabled = searchParams.get("enabled")

    if (!workspaceId) {
      return apiError("MISSING_PARAM", "workspaceId is required", 400)
    }

    await requirePermission(workspaceId, PERMISSIONS.schedule.view)

    const { cursor, limit } = parsePaginationParams(searchParams)

    const result = await listSchedules({
      workspaceId,
      ...(targetId ? { targetId } : {}),
      ...(enabled === "true" || enabled === "false" ? { enabled: enabled === "true" } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    })

    return apiPaginated(result.items, result.nextCursor)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to list schedules", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to list schedules", 500)
  }
}

const CreateScheduleSchema = z.object({
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  cron: z
    .string()
    .min(1, "cron expression is required")
    .refine(
      (c) => getNextRunAt(c.trim()) !== null,
      "Use a five-field schedule like '0 0 * * 0' or '30 8 * * *'"
    ),
  goal: z.enum(["CHECK_PR", "TEST_APP", "LAUNCH_REVIEW", "WEEKLY_MONITOR", "FULL_PENTEST", "COMPLIANCE_REVIEW"]),
  mode: z.enum(["SAFE", "QUICK", "STANDARD", "DEEP"]).default("SAFE"),
})

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const parsed = CreateScheduleSchema.safeParse(body)

    if (!parsed.success) {
      return apiError("INVALID_PARAM", parsed.error.issues[0]?.message ?? "Invalid input", 400)
    }

    const { workspaceId, targetId, cron, goal, mode } = parsed.data

    const { session } = await requirePermission(workspaceId, PERMISSIONS.schedule.create)

    const target = await prisma.target.findFirst({
      where: { id: targetId, workspaceId, deletedAt: null },
    })
    if (!target) {
      return apiError("TARGET_NOT_FOUND", "Target not found", 404)
    }

    const existing = await prisma.schedule.findFirst({
      where: { targetId, workspaceId, deletedAt: null, enabled: true },
    })
    if (existing) {
      return apiError("SCHEDULE_EXISTS", "An active schedule already exists for this target", 409)
    }

    const schedule = await createSchedule({
      workspaceId,
      targetId,
      cron: cron.trim(),
      goal,
      mode,
      createdById: session.userId,
    })

    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorUserId: session.userId,
        action: "schedule.created",
        resourceType: "schedule",
        resourceId: schedule.id,
      },
    })

    return apiSuccess(schedule, 201)
  } catch (error) {
    const authErr = authErrorResponse(error)
    if (authErr) return authErr
    logger.error("Failed to create schedule", { error: String(error) })
    return apiError("INTERNAL_ERROR", "Failed to create schedule", 500)
  }
}
