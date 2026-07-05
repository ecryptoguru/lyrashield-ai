import { prisma } from "./client"
import type { Schedule, ScanGoal, ScanMode } from "./generated/prisma"
import { logger } from "@lyrashield/logger"

export interface ScheduleWithDetails extends Schedule {
  target: { id: string; name: string; type: string; url: string | null }
}

export async function createSchedule(params: {
  workspaceId: string
  targetId: string
  cron: string
  goal: string
  mode?: string
  createdById: string
}): Promise<Schedule> {
  const schedule = await prisma.schedule.create({
    data: {
      workspaceId: params.workspaceId,
      targetId: params.targetId,
      cron: params.cron,
      goal: params.goal as ScanGoal,
      mode: (params.mode ?? "SAFE") as ScanMode,
      createdById: params.createdById,
      enabled: true,
    },
  })

  logger.info("Schedule created", {
    workspaceId: params.workspaceId,
    scheduleId: schedule.id,
    targetId: params.targetId,
    cron: params.cron,
  })

  return schedule
}

export async function getSchedule(
  scheduleId: string,
  workspaceId: string
): Promise<ScheduleWithDetails | null> {
  const schedule = await prisma.schedule.findFirst({
    where: { id: scheduleId, workspaceId, deletedAt: null },
    include: {
      target: { select: { id: true, name: true, type: true, url: true } },
    },
  })

  return schedule as ScheduleWithDetails | null
}

export async function listSchedules(params: {
  workspaceId: string
  targetId?: string
  enabled?: boolean
  cursor?: string
  limit?: number
}): Promise<{ items: ScheduleWithDetails[]; nextCursor: string | null }> {
  const limit = Math.min(params.limit ?? 20, 50)

  const schedules = await prisma.schedule.findMany({
    where: {
      workspaceId: params.workspaceId,
      deletedAt: null,
      ...(params.targetId ? { targetId: params.targetId } : {}),
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
    },
    include: {
      target: { select: { id: true, name: true, type: true, url: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  })

  const nextCursor = schedules.length > limit ? schedules[limit]!.id : null
  const items = schedules.slice(0, limit) as ScheduleWithDetails[]

  return { items, nextCursor }
}

export async function updateSchedule(
  scheduleId: string,
  workspaceId: string,
  data: { cron?: string; goal?: string; mode?: string; enabled?: boolean }
): Promise<Schedule> {
  const schedule = await prisma.schedule.findFirst({
    where: { id: scheduleId, workspaceId, deletedAt: null },
  })

  if (!schedule) {
    throw new Error(`Schedule not found: ${scheduleId}`)
  }

  return prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      ...(data.cron ? { cron: data.cron } : {}),
      ...(data.goal ? { goal: data.goal as ScanGoal } : {}),
      ...(data.mode ? { mode: data.mode as ScanMode } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    },
  })
}

export async function deleteSchedule(
  scheduleId: string,
  workspaceId: string
): Promise<void> {
  const schedule = await prisma.schedule.findFirst({
    where: { id: scheduleId, workspaceId, deletedAt: null },
  })

  if (!schedule) {
    throw new Error(`Schedule not found: ${scheduleId}`)
  }

  await prisma.schedule.update({
    where: { id: scheduleId },
    data: { deletedAt: new Date() },
  })
}

export async function updateScheduleRunTimes(
  scheduleId: string,
  lastRunAt: Date,
  nextRunAt: Date
): Promise<void> {
  await prisma.schedule.update({
    where: { id: scheduleId },
    data: { lastRunAt, nextRunAt },
  })
}

export async function getDueSchedules(now: Date): Promise<ScheduleWithDetails[]> {
  const schedules = await prisma.schedule.findMany({
    where: {
      enabled: true,
      deletedAt: null,
      nextRunAt: { lte: now },
    },
    include: {
      target: { select: { id: true, name: true, type: true, url: true } },
    },
    take: 50,
  })

  return schedules as ScheduleWithDetails[]
}
