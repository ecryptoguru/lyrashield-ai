import { prisma } from "./client"
import type { Schedule, ScanGoal, ScanMode } from "./generated/prisma"
import { logger } from "@lyrashield/logger"

export interface ScheduleWithDetails extends Schedule {
  target: { id: string; name: string; type: string; url: string | null }
}

function parseCronField(value: string, min: number, max: number): number | "*" | null {
  if (value === "*") return "*"
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null
  return parsed
}

export function getNextRunAt(cron: string, after = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const [minuteRaw, hourRaw, dayOfMonthRaw, monthRaw, dayOfWeekRaw] = parts
  if (dayOfMonthRaw !== "*" || monthRaw !== "*") return null
  const minute = parseCronField(minuteRaw!, 0, 59)
  const hour = parseCronField(hourRaw!, 0, 23)
  const dayOfWeek = parseCronField(dayOfWeekRaw!, 0, 6)
  if (minute === null || hour === null || dayOfWeek === null) return null

  const candidate = new Date(after)
  candidate.setUTCSeconds(0, 0)
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)

  for (let i = 0; i < 60 * 24 * 8; i += 1) {
    const minuteMatches = minute === "*" || candidate.getUTCMinutes() === minute
    const hourMatches = hour === "*" || candidate.getUTCHours() === hour
    const dayMatches = dayOfWeek === "*" || candidate.getUTCDay() === dayOfWeek

    if (minuteMatches && hourMatches && dayMatches) {
      return new Date(candidate)
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
  }

  return null
}

export async function createSchedule(params: {
  workspaceId: string
  targetId: string
  cron: string
  goal: string
  mode?: string
  createdById: string
}): Promise<Schedule> {
  const nextRunAt = getNextRunAt(params.cron)
  if (!nextRunAt) {
    throw new Error(
      "Unsupported cron expression. Use five fields with numeric minute/hour and optional day-of-week."
    )
  }

  const schedule = await prisma.schedule.create({
    data: {
      workspaceId: params.workspaceId,
      targetId: params.targetId,
      cron: params.cron,
      goal: params.goal as ScanGoal,
      mode: (params.mode ?? "SAFE") as ScanMode,
      createdById: params.createdById,
      enabled: true,
      nextRunAt,
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
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  })

  const hasMore = schedules.length > limit
  const items = (hasMore ? schedules.slice(0, limit) : schedules) as ScheduleWithDetails[]
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.id : null

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

  const nextRunAt = data.cron
    ? getNextRunAt(data.cron)
    : data.enabled === true && !schedule.nextRunAt
      ? getNextRunAt(schedule.cron)
      : null
  if (data.cron && !nextRunAt) {
    throw new Error(
      "Unsupported cron expression. Use five fields with numeric minute/hour and optional day-of-week."
    )
  }

  return prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      ...(data.cron ? { cron: data.cron } : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
      ...(data.goal ? { goal: data.goal as ScanGoal } : {}),
      ...(data.mode ? { mode: data.mode as ScanMode } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
    },
  })
}

export async function deleteSchedule(scheduleId: string, workspaceId: string): Promise<void> {
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

/**
 * Atomically claim a due schedule before creating a scan. This prevents two
 * worker replicas from enqueueing the same run after reading it concurrently.
 */
export async function claimDueSchedule(
  scheduleId: string,
  lastRunAt: Date,
  nextRunAt: Date
): Promise<boolean> {
  const result = await prisma.schedule.updateMany({
    where: {
      id: scheduleId,
      enabled: true,
      deletedAt: null,
      nextRunAt: { lte: lastRunAt },
    },
    data: { lastRunAt, nextRunAt },
  })

  return result.count === 1
}

export async function getDueSchedules(now: Date): Promise<ScheduleWithDetails[]> {
  const schedules = await prisma.schedule.findMany({
    where: {
      enabled: true,
      deletedAt: null,
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    include: {
      target: { select: { id: true, name: true, type: true, url: true } },
    },
    take: 50,
  })

  return schedules as ScheduleWithDetails[]
}
