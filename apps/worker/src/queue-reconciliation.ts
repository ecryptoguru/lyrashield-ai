import { prisma, updateScanStatus } from "@lyrashield/db"
import { getRedis } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { getScanQueue } from "./queue"

const RECONCILIATION_LOCK_KEY = "lyrashield:scan-queue:reconciliation"
const RECONCILIATION_LOCK_MS = 55_000
const ORPHAN_GRACE_MS = 5 * 60_000
const BATCH_SIZE = 500
const ACTIVE_SCAN_STATUSES = new Set(["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"])

export interface QueueReconciliationResult {
  failedOrphanedScans: number
  removedOrphanedJobs: number
}

export async function reconcileScanQueue(now = new Date()): Promise<QueueReconciliationResult> {
  const result = { failedOrphanedScans: 0, removedOrphanedJobs: 0 }
  const redis = getRedis()
  if (!redis) return result

  const acquired = await redis.set(
    RECONCILIATION_LOCK_KEY,
    "leased",
    "PX",
    RECONCILIATION_LOCK_MS,
    "NX"
  )
  if (acquired !== "OK") return result

  // The lease deliberately expires just before the 60-second reconciliation interval.
  // Leaving expiry to Redis avoids releasing a newer owner's lock after a slow run.
  const queue = getScanQueue()
  const staleQueuedScans = await prisma.scan.findMany({
    where: {
      status: "QUEUED",
      deletedAt: null,
      createdAt: { lt: new Date(now.getTime() - ORPHAN_GRACE_MS) },
    },
    select: { id: true },
    take: BATCH_SIZE,
  })

  for (const scan of staleQueuedScans) {
    const job = await queue.getJob(scan.id)
    const state = job ? await job.getState() : "missing"
    if (state !== "missing" && state !== "failed" && state !== "completed") continue

    try {
      await updateScanStatus(scan.id, "FAILED", {
        errorCategory: "QUEUE",
        errorMessage: "QUEUE_ORPHANED: queued scan has no processable queue job",
      })
      result.failedOrphanedScans += 1
    } catch (error) {
      logger.warn("Could not reconcile orphaned scan", {
        scanId: scan.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const jobs = await queue.getJobs(["wait", "delayed", "prioritized", "paused"], 0, BATCH_SIZE - 1)
  const jobIds = jobs.map((job) => job.id).filter((id): id is string => Boolean(id))
  const scans = jobIds.length
    ? await prisma.scan.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, status: true },
      })
    : []
  const scanStatuses = new Map(scans.map((scan) => [scan.id, scan.status]))

  for (const job of jobs) {
    if (!job.id) continue
    const status = scanStatuses.get(job.id)
    if (status && ACTIVE_SCAN_STATUSES.has(status)) continue

    try {
      await job.remove()
      result.removedOrphanedJobs += 1
    } catch (error) {
      logger.warn("Could not remove orphaned queue job", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (result.failedOrphanedScans || result.removedOrphanedJobs) {
    logger.warn("Scan queue reconciliation repaired drift", result)
  }
  return result
}

export async function reconcileFailedQueueJob(jobId: string, failedReason: string): Promise<void> {
  const scan = await prisma.scan.findUnique({
    where: { id: jobId },
    select: { status: true },
  })
  if (!scan || !ACTIVE_SCAN_STATUSES.has(scan.status)) return

  try {
    await updateScanStatus(jobId, "FAILED", {
      errorCategory: "QUEUE",
      errorMessage: `Queue job failed: ${failedReason.slice(0, 500)}`,
    })
  } catch (error) {
    logger.warn("Could not reconcile failed queue job", {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
