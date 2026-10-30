import {
  ACTIVE_SCAN_STATUSES,
  advanceBlockedSchedule,
  restoreUnsubmittedScheduleOccurrence,
  createScheduledScan,
  getDueSchedules,
  getNextRunAt,
  findCurrentDomainProof,
  prisma,
  releaseUnstartedScanSlot,
  runWithAccountContext,
  runWithWorkspaceContext,
  updateScanStatus,
  type ScheduleBlockedReason,
} from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { MAX_CONCURRENT_WORKSPACE_SCANS } from "@lyrashield/types"
import { evaluateScanEntitlement } from "@lyrashield/billing"
import { resolveAvailableUrlReview, ScanEnqueueNotSubmittedError } from "@lyrashield/integrations"
import { assertScanWorkerAvailable, enqueueScan } from "./queue"
import { notifyScheduleBlocked } from "./notifications"

type DueSchedule = Awaited<ReturnType<typeof getDueSchedules>>[number]
type ScheduleAdmission =
  { status: "eligible" | "defer" } | { status: "blocked"; reason: ScheduleBlockedReason }

async function scheduledScanAdmission(schedule: DueSchedule): Promise<ScheduleAdmission> {
  if (!schedule.createdById) return { status: "blocked", reason: "SCAN_ELIGIBILITY_REQUIRED" }
  // Read uncertainty, infrastructure loss and active work never consume cadence.
  // Any thrown read leaves the one due timestamp pending for the next poll.
  const entitlement = await runWithAccountContext(schedule.createdById, () =>
    evaluateScanEntitlement({
      workspaceId: schedule.workspaceId,
      mode: schedule.mode,
      sponsorAccountId: schedule.createdById,
      mutateOnTrialExpiry: true,
      deferCapacityCheck: true,
    })
  )
  if (!entitlement.allowed) return { status: "blocked", reason: "SCAN_ELIGIBILITY_REQUIRED" }

  const review = await resolveAvailableUrlReview({
    targetType: schedule.target.type,
    mode: schedule.mode,
    hasApiSpec: Boolean(schedule.target.apiSpecUrl),
  })
  if (!review.ok) {
    return review.code === "TARGET_RELAY_UNAVAILABLE"
      ? { status: "defer" }
      : { status: "blocked", reason: "SCAN_PROFILE_UNAVAILABLE" }
  }
  if (review.engineBacked) {
    const proof = await findCurrentDomainProof(schedule.workspaceId, schedule.target.url)
    if (!proof.verified) return { status: "blocked", reason: "DOMAIN_VERIFICATION_REQUIRED" }
  }

  const activeScans = await prisma.scan.count({
    where: {
      workspaceId: schedule.workspaceId,
      targetId: schedule.targetId,
      status: { in: [...ACTIVE_SCAN_STATUSES] },
    },
  })
  if (activeScans > 0) return { status: "defer" }
  const activeWorkspaceScans = await prisma.scan.count({
    where: { workspaceId: schedule.workspaceId, status: { in: [...ACTIVE_SCAN_STATUSES] } },
  })
  if (activeWorkspaceScans >= MAX_CONCURRENT_WORKSPACE_SCANS) return { status: "defer" }
  return { status: "eligible" }
}

// A restart may revisit rows safely: occurrence CAS is the durable authority.
let dueScheduleCursor: string | undefined
const SCHEDULE_POLL_BUDGET_MS = 15_000

export async function processDueSchedules(now = new Date()): Promise<number> {
  const deadline = Date.now() + SCHEDULE_POLL_BUDGET_MS
  let schedules = await getDueSchedules(now, dueScheduleCursor)
  if (!schedules.length && dueScheduleCursor) {
    dueScheduleCursor = undefined
    schedules = await getDueSchedules(now)
  }
  let enqueued = 0
  let processed = 0
  for (const schedule of schedules) {
    if (Date.now() >= deadline) break
    let workerUnavailable = false
    await runWithWorkspaceContext(schedule.workspaceId, async () => {
      try {
        // Coalesce every missed interval into this single pending occurrence.
        const nextRunAt = getNextRunAt(schedule.cron, now)
        if (!nextRunAt) {
          await prisma.schedule.updateMany({
            where: {
              id: schedule.id,
              workspaceId: schedule.workspaceId,
              updatedAt: schedule.updatedAt,
            },
            data: {
              enabled: false,
              lastBlockedAt: now,
              lastBlockedReason: "SCHEDULE_CRON_UNSUPPORTED",
            },
          })
          logger.warn("Disabled schedule with unsupported cron expression", {
            scheduleId: schedule.id,
          })
          return
        }
        try {
          await assertScanWorkerAvailable()
        } catch {
          workerUnavailable = true
          return
        }
        const admission = await scheduledScanAdmission(schedule)
        if (admission.status === "defer") return
        if (admission.status === "blocked") {
          if (await advanceBlockedSchedule(schedule, now, nextRunAt, admission.reason)) {
            await notifyScheduleBlocked(
              schedule.workspaceId,
              schedule.id,
              schedule.target.name,
              admission.reason,
              now.toISOString().slice(0, 10)
            )
          }
          return
        }
        // User-slot/workspace/target contention rolls back the occurrence too.
        const scan = await createScheduledScan(schedule, now, nextRunAt)
        if (!scan) return
        try {
          await enqueueScan({
            scanId: scan.id,
            workspaceId: schedule.workspaceId,
            targetId: schedule.targetId,
            goal: schedule.goal,
            mode: schedule.mode,
          })
          enqueued += 1
          logger.info("Scheduled scan enqueued", { scheduleId: schedule.id, scanId: scan.id })
        } catch (error) {
          // This scan was freshly created by the winning occurrence CAS in
          // THIS invocation. A no-add error says nothing about prior attempts;
          // never apply this reset to recovered/reused queue identities.
          if (!(error instanceof ScanEnqueueNotSubmittedError) || error.scanId !== scan.id) {
            logger.error("Scheduled publication uncertain; retained original scan identity", {
              scanId: scan.id,
              error: String(error),
            })
            return
          }
          await updateScanStatus(
            scan.id,
            "FAILED",
            {
              errorCategory: "QUEUE",
              errorMessage: "Scan worker became unavailable while queueing the scheduled scan",
            },
            schedule.workspaceId
          )
          await releaseUnstartedScanSlot(schedule.workspaceId, scan.id)
          await restoreUnsubmittedScheduleOccurrence(schedule, scan.id, now, nextRunAt)
          logger.error("Failed to enqueue scheduled scan", {
            scheduleId: schedule.id,
            scanId: scan.id,
            error: String(error),
          })
        }
      } catch (error) {
        logger.warn("Scheduled review processing could not finish", {
          scheduleId: schedule.id,
          workspaceId: schedule.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
    processed += 1
    dueScheduleCursor = schedule.id
    if (workerUnavailable) break
  }
  if (processed === schedules.length && schedules.length < 50) dueScheduleCursor = undefined
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
