import { randomUUID } from "node:crypto"
import type Redis from "ioredis"
import { prisma, type ScanStatus, updateScanStatus } from "@lyrashield/db"
import { getRedis } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { getScanQueue } from "./queue"

const RECONCILIATION_LOCK_KEY = "lyrashield:scan-queue:reconciliation"
const RECONCILIATION_LOCK_MS = 55_000
const RECONCILIATION_LOCK_RENEW_MS = 20_000
const ORPHAN_GRACE_MS = 5 * 60_000
const BATCH_SIZE = 500
const ACTIVE_SCAN_STATUSES = new Set<ScanStatus>(["QUEUED", "PREFLIGHT", "RUNNING", "VERIFYING"])

export interface QueueReconciliationResult {
  failedOrphanedScans: number
  removedOrphanedJobs: number
}

class ReconciliationLease {
  private lost = false
  private renewalTimer: NodeJS.Timeout | null = null
  private renewalPromise: Promise<void> | null = null

  private constructor(
    private readonly client: Redis,
    private readonly token: string
  ) {}

  static async acquire(redis: Redis): Promise<ReconciliationLease | null> {
    const client = redis.duplicate()
    client.on("error", (error) => {
      logger.warn("Scan queue reconciliation lease Redis error", { error: error.message })
    })

    const token = randomUUID()
    try {
      const acquired = await client.set(
        RECONCILIATION_LOCK_KEY,
        token,
        "PX",
        RECONCILIATION_LOCK_MS,
        "NX"
      )
      if (acquired !== "OK") {
        client.disconnect()
        return null
      }

      const lease = new ReconciliationLease(client, token)
      lease.startRenewal()
      return lease
    } catch (error) {
      client.disconnect()
      throw error
    }
  }

  assertOwned(): void {
    if (this.lost) {
      throw new Error("Scan queue reconciliation lease was lost")
    }
  }

  private startRenewal(): void {
    this.renewalTimer = setInterval(() => {
      if (this.renewalPromise || this.lost) return
      const renewalPromise = this.renewOwned()
        .then((renewed) => {
          if (!renewed) this.lost = true
        })
        .catch((error) => {
          this.lost = true
          logger.warn("Could not renew scan queue reconciliation lease", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          if (this.renewalPromise === renewalPromise) this.renewalPromise = null
        })
      this.renewalPromise = renewalPromise
    }, RECONCILIATION_LOCK_RENEW_MS)
  }

  private async renewOwned(): Promise<boolean> {
    await this.client.watch(RECONCILIATION_LOCK_KEY)
    try {
      if ((await this.client.get(RECONCILIATION_LOCK_KEY)) !== this.token) return false
      const result = await this.client
        .multi()
        .pexpire(RECONCILIATION_LOCK_KEY, RECONCILIATION_LOCK_MS)
        .exec()
      return result !== null
    } finally {
      await this.client.unwatch()
    }
  }

  async release(): Promise<void> {
    if (this.renewalTimer) clearInterval(this.renewalTimer)
    await this.renewalPromise

    try {
      await this.client.watch(RECONCILIATION_LOCK_KEY)
      if ((await this.client.get(RECONCILIATION_LOCK_KEY)) === this.token) {
        await this.client.multi().del(RECONCILIATION_LOCK_KEY).exec()
      }
      await this.client.unwatch()
      await this.client.quit()
    } catch (error) {
      this.client.disconnect()
      logger.warn("Could not release scan queue reconciliation lease", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export async function reconcileScanQueue(now = new Date()): Promise<QueueReconciliationResult> {
  const result = { failedOrphanedScans: 0, removedOrphanedJobs: 0 }
  const redis = getRedis()
  if (!redis) return result

  const lease = await ReconciliationLease.acquire(redis)
  if (!lease) return result

  try {
    const queue = getScanQueue()
    let scanCursor: string | undefined
    do {
      const staleScans = await prisma.scan.findMany({
        where: {
          status: { in: [...ACTIVE_SCAN_STATUSES] },
          deletedAt: null,
          updatedAt: { lt: new Date(now.getTime() - ORPHAN_GRACE_MS) },
        },
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: BATCH_SIZE,
        ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
      })

      for (const scan of staleScans) {
        lease.assertOwned()
        const job = await queue.getJob(scan.id)
        const state = job ? await job.getState() : "missing"
        if (state !== "missing" && state !== "failed" && state !== "completed") continue

        try {
          lease.assertOwned()
          await updateScanStatus(scan.id, "FAILED", {
            errorCategory: "QUEUE",
            errorMessage: "QUEUE_ORPHANED: active scan has no processable queue job",
          })
          result.failedOrphanedScans += 1
        } catch (error) {
          logger.warn("Could not reconcile orphaned scan", {
            scanId: scan.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      scanCursor = staleScans.at(-1)?.id
      if (staleScans.length < BATCH_SIZE) scanCursor = undefined
    } while (scanCursor)

    lease.assertOwned()
    const jobs = [] as Awaited<ReturnType<typeof queue.getJobs>>
    for (let start = 0; ; start += BATCH_SIZE) {
      const page = await queue.getJobs(
        ["wait", "delayed", "prioritized", "paused"],
        start,
        start + BATCH_SIZE - 1
      )
      jobs.push(...page)
      if (page.length < BATCH_SIZE) break
    }
    const jobIds = jobs.map((job) => job.id).filter((id): id is string => Boolean(id))
    const scans = jobIds.length
      ? await prisma.scan.findMany({
          where: { id: { in: jobIds } },
          select: { id: true, status: true },
        })
      : []
    const scanStatuses = new Map(scans.map((scan) => [scan.id, scan.status]))

    for (const job of jobs) {
      lease.assertOwned()
      if (!job.id) continue
      const status = scanStatuses.get(job.id)
      if (status && ACTIVE_SCAN_STATUSES.has(status)) continue

      try {
        lease.assertOwned()
        await job.remove()
        result.removedOrphanedJobs += 1
      } catch (error) {
        logger.warn("Could not remove orphaned queue job", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    lease.assertOwned()
    if (result.failedOrphanedScans || result.removedOrphanedJobs) {
      logger.warn("Scan queue reconciliation repaired drift", result)
    }
    return result
  } finally {
    await lease.release()
  }
}

export async function reconcileFailedQueueJob(jobId: string, failedReason: string): Promise<void> {
  try {
    const scan = await prisma.scan.findUnique({
      where: { id: jobId },
      select: { status: true },
    })
    if (!scan || !ACTIVE_SCAN_STATUSES.has(scan.status)) return

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
