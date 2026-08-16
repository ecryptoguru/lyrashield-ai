import {
  createScan,
  claimDueSchedule,
  getDueSchedules,
  getNextRunAt,
  prisma,
  runWithWorkspaceContext,
  updateScanStatus,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { MAX_CONCURRENT_WORKSPACE_SCANS, resolveTargetScanMode } from "@lyrashield/types"
import { assertScanWorkerAvailable, enqueueScan } from "./queue"

const ACTIVE_SCAN_STATUSES = [
  "QUEUED",
  "PREFLIGHT",
  "RUNNING",
  "VERIFYING",
  "REQUIRES_APPROVAL",
] as const

export async function processDueSchedules(now = new Date()): Promise<number> {
  const schedules = await getDueSchedules(now)
  let enqueued = 0

  for (const schedule of schedules) {
    let workerUnavailable = false
    await runWithWorkspaceContext(schedule.workspaceId, async () => {
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
          return
        }

        try {
          // Do not advance a schedule unless this worker can still accept its scan.
          await assertScanWorkerAvailable()
        } catch (error) {
          logger.warn("Scan worker unavailable; pausing scheduled scan processing", {
            error: error instanceof Error ? error.message : String(error),
          })
          workerUnavailable = true
          return
        }

        if (!(await claimDueSchedule(schedule.id, now, nextRunAt))) {
          return
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
          return
        }

        // Schedules must not bypass the workspace concurrency cap that the
        // scan-create API enforces: N schedules on N targets due in the same
        // minute would otherwise launch N concurrent billable scans at once.
        const activeWorkspaceScans = await prisma.scan.count({
          where: {
            workspaceId: schedule.workspaceId,
            status: { in: [...ACTIVE_SCAN_STATUSES] },
          },
        })
        if (activeWorkspaceScans >= MAX_CONCURRENT_WORKSPACE_SCANS) {
          logger.info(
            "Skipping scheduled scan because workspace is at its concurrent scan cap",
            {
              scheduleId: schedule.id,
              workspaceId: schedule.workspaceId,
              activeWorkspaceScans,
              cap: MAX_CONCURRENT_WORKSPACE_SCANS,
            }
          )
          return
        }

        if (schedule.target.type === "WEB_APP" || schedule.target.type === "API") {
          const resolved = resolveTargetScanMode({
            targetType: schedule.target.type,
            mode: schedule.mode,
            hasApiSpec: Boolean(schedule.target.apiSpecUrl),
          })
          if (!resolved.ok) {
            await prisma.schedule.update({
              where: { id: schedule.id },
              data: { enabled: false },
            })
            logger.warn("Disabled schedule with unavailable mode", {
              scheduleId: schedule.id,
              targetId: schedule.targetId,
              targetType: schedule.target.type,
              mode: schedule.mode,
              reason: resolved.reason,
              code: resolved.code,
            })
            return
          }
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
          await updateScanStatus(
            scan.id,
            "FAILED",
            {
              errorCategory: "QUEUE",
              errorMessage: "Scan worker became unavailable while queueing the scheduled scan",
            },
            schedule.workspaceId
          )
        }
      } catch (error) {
        logger.error("Failed to process scheduled scan", {
          scheduleId: schedule.id,
          workspaceId: schedule.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
    if (workerUnavailable) break
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
