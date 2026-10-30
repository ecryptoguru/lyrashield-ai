import { targetReadScopeWhere } from "./read-query-scope"
import { prisma } from "./client"
import { getSystemPrisma } from "./system-client"
import type { Schedule, ScanGoal, ScanMode, Prisma } from "./generated/prisma"
import { createScan } from "./scan-service"
import { withWorkspaceRLS } from "./rls"
import { lockUserScanAdmission } from "./scan-slot"
import { logger } from "@lyrashield/logger"

export interface ScheduleWithDetails extends Schedule {
  target: { id: string; name: string; type: string; url: string | null; apiSpecUrl: string | null }
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
      mode: (params.mode ?? "QUICK") as ScanMode,
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
  workspaceId: string,
  targetIds?: string[]
): Promise<ScheduleWithDetails | null> {
  const schedule = await prisma.schedule.findFirst({
    where: { id: scheduleId, workspaceId, deletedAt: null, ...targetReadScopeWhere({ targetIds }) },
    include: {
      target: { select: { id: true, name: true, type: true, url: true, apiSpecUrl: true } },
    },
  })

  return schedule as ScheduleWithDetails | null
}

export async function listSchedules(params: {
  workspaceId: string
  targetId?: string
  targetIds?: string[]
  enabled?: boolean
  cursor?: string
  limit?: number
}): Promise<{ items: ScheduleWithDetails[]; nextCursor: string | null }> {
  const limit = Math.min(params.limit ?? 20, 50)

  const schedules = await prisma.schedule.findMany({
    where: {
      workspaceId: params.workspaceId,
      deletedAt: null,
      ...targetReadScopeWhere(params),
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
    },
    include: {
      target: { select: { id: true, name: true, type: true, url: true, apiSpecUrl: true } },
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
  workspaceId: string,
  lastRunAt: Date,
  nextRunAt: Date
): Promise<void> {
  await prisma.schedule.update({
    where: { id: scheduleId, workspaceId },
    data: { lastRunAt, nextRunAt },
  })
}

export type ScheduleBlockedReason =
  "SCAN_ELIGIBILITY_REQUIRED" | "DOMAIN_VERIFICATION_REQUIRED" | "SCAN_PROFILE_UNAVAILABLE"

function pendingOccurrenceWhere(schedule: Schedule, now: Date): Prisma.ScheduleWhereInput {
  return {
    id: schedule.id,
    workspaceId: schedule.workspaceId,
    enabled: true,
    deletedAt: null,
    updatedAt: schedule.updatedAt,
    nextRunAt: schedule.nextRunAt,
    target: { deletedAt: null },
    OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
  }
}

/**
 * One due timestamp is the pending occurrence; all missed cadence coalesces to
 * this scan. The claim and shared scan/slot/reservation creation commit together.
 * A crash before commit or any admission contention leaves the timestamp due.
 */
export async function createScheduledScan(schedule: Schedule, now: Date, nextRunAt: Date) {
  if (nextRunAt <= now) throw new Error("schedule_next_run_must_be_future")
  return withWorkspaceRLS(schedule.workspaceId, async (tx) => {
    // Preserve the global user-first order before locking the occurrence row.
    await lockUserScanAdmission(tx, schedule.createdById)
    const claimed = await tx.schedule.updateMany({
      where: pendingOccurrenceWhere(schedule, now),
      data: {
        lastRunAt: now,
        nextRunAt,
        lastBlockedAt: null,
        lastBlockedReason: null,
        updatedAt: now,
      },
    })
    if (!claimed.count) return null
    const scan = await createScan(
      {
        workspaceId: schedule.workspaceId,
        targetId: schedule.targetId,
        goal: schedule.goal,
        mode: schedule.mode,
        createdById: schedule.createdById,
        triggerType: "schedule",
      },
      tx
    )
    await tx.schedule.update({
      where: { id: schedule.id, workspaceId: schedule.workspaceId },
      data: { lastScanId: scan.id, updatedAt: now },
    })
    return scan
  })
}

/**
 * Call only for a scan freshly created by this publication invocation, after
 * typed proof queue.add was never called. This function alone cannot prove
 * absence of an earlier publication. Unknown/previous jobs must stay held.
 */
export async function restoreUnsubmittedScheduleOccurrence(
  schedule: Schedule,
  scanId: string,
  claimedAt: Date,
  nextRunAt: Date
): Promise<boolean> {
  return withWorkspaceRLS(schedule.workspaceId, async (tx) => {
    await lockUserScanAdmission(tx, schedule.createdById)
    const scan = await tx.scan.findFirst({
      where: {
        id: scanId,
        workspaceId: schedule.workspaceId,
        createdById: schedule.createdById,
        triggerType: "schedule",
        accountingVersion: 2,
        status: "FAILED",
        startedAt: null,
      },
    })
    if (!scan) return false
    const accountId = scan.sponsorAccountId ?? scan.createdById
    await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`
    const reservation = await tx.scanCapacityReservation.findUnique({ where: { scanId } })
    const slot = await tx.userScanSlot.findUnique({ where: { userId: schedule.createdById } })
    if (
      !reservation ||
      reservation.state !== "RELEASED" ||
      !reservation.stoppedAt ||
      reservation.observedMs !== 0 ||
      reservation.chargedMinutes !== 0 ||
      slot?.scanId === scanId
    )
      return false
    const result = await tx.schedule.updateMany({
      where: {
        id: schedule.id,
        workspaceId: schedule.workspaceId,
        enabled: true,
        deletedAt: null,
        updatedAt: claimedAt,
        lastRunAt: claimedAt,
        nextRunAt,
        lastScanId: scanId,
      },
      data: { nextRunAt: schedule.nextRunAt, lastRunAt: schedule.lastRunAt },
    })
    return result.count === 1
  })
}

/** Permanent denial advances one occurrence and keeps a bounded reason. */
export async function advanceBlockedSchedule(
  schedule: Schedule,
  now: Date,
  nextRunAt: Date,
  reason: ScheduleBlockedReason
): Promise<boolean> {
  if (nextRunAt <= now) throw new Error("schedule_next_run_must_be_future")
  return withWorkspaceRLS(schedule.workspaceId, async (tx) => {
    const result = await tx.schedule.updateMany({
      where: pendingOccurrenceWhere(schedule, now),
      data: { lastRunAt: now, nextRunAt, lastBlockedAt: now, lastBlockedReason: reason },
    })
    return result.count === 1
  })
}

/**
 * Legacy timestamp-only helper. Scan admission must use createScheduledScan
 * so an occurrence cannot commit without its scan and capacity reservation.
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

export async function getDueSchedules(now: Date, afterId?: string): Promise<ScheduleWithDetails[]> {
  // The schedule runner is a cross-workspace background process. Use the
  // privileged system client so it can read due schedules from all tenants.
  const schedules = await getSystemPrisma().schedule.findMany({
    where: {
      enabled: true,
      deletedAt: null,
      ...(afterId ? { id: { gt: afterId } } : {}),
      // The system client bypasses the extension's soft-delete guard, so the
      // join must name it: a schedule whose target was deleted must not fire.
      target: { deletedAt: null },
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    include: {
      target: { select: { id: true, name: true, type: true, url: true, apiSpecUrl: true } },
    },
    orderBy: { id: "asc" },
    take: 50,
  })

  return schedules as ScheduleWithDetails[]
}
