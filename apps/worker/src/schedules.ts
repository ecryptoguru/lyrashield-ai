import {
  createScan,
  claimDueSchedule,
  getDueSchedules,
  getNextRunAt,
  prisma,
  updateScanStatus,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { enqueueScan } from "./queue"

const ACTIVE_SCAN_STATUSES = ["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING", "REQUIRES_APPROVAL"] as const

export async function processDueSchedules(now = new Date()): Promise<number> {
  const schedules = await getDueSchedules(now)
  let enqueued = 0

  for (const schedule of schedules) {
    try {
      const nextRunAt = getNextRunAt(schedule.cron, now)
      if (!nextRunAt) {
        await prisma.schedule.update({
          where: { id: schedule.id },
          data: { enabled: false },
        })
        logger.warn("Disabled schedule with unsupported cron expression", {
          scheduleId: schedule.id,
          workspaceId: schedule.workspaceId,
          cron: schedule.cron,
        })
        continue
      }

      if (!await claimDueSchedule(schedule.id, now, nextRunAt)) {
        continue
      }

      const activeScans = await prisma.scan.count({
        where: {
          targetId: schedule.targetId,
          status: { in: [...ACTIVE_SCAN_STATUSES] },
        },
      })

      if (activeScans > 0) {
        logger.info("Skipping scheduled scan because target already has an active scan", {
          scheduleId: schedule.id,
          targetId: schedule.targetId,
        })
        continue
      }

      const scan = await createScan({
        workspaceId: schedule.workspaceId,
        targetId: schedule.targetId,
        goal: schedule.goal,
        mode: schedule.mode,
        createdById: schedule.createdById,
        triggerType: "schedule",
      })

      try {
        await enqueueScan({
          scanId: scan.id,
          workspaceId: schedule.workspaceId,
          targetId: schedule.targetId,
          goal: schedule.goal,
          mode: schedule.mode,
        })
        enqueued += 1
        logger.info("Scheduled scan enqueued", {
          scheduleId: schedule.id,
          scanId: scan.id,
          targetId: schedule.targetId,
        })
      } catch (error) {
        logger.error("Failed to enqueue scheduled scan", {
          scheduleId: schedule.id,
          scanId: scan.id,
          error: error instanceof Error ? error.message : String(error),
        })
        await updateScanStatus(scan.id, "FAILED", {
          errorCategory: "QUEUE",
          errorMessage: "Failed to enqueue scheduled scan job - Redis may be unavailable",
        })
      }
    } catch (error) {
      logger.error("Failed to process scheduled scan", {
        scheduleId: schedule.id,
        workspaceId: schedule.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return enqueued
}

function runSchedulePoll(): void {
  void processDueSchedules().catch((error) => {
    logger.error("Schedule runner poll failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

export function startScheduleRunner(intervalMs = 60_000): NodeJS.Timeout {
  runSchedulePoll()
  return setInterval(runSchedulePoll, intervalMs)
}
