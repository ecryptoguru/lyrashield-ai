import { randomUUID } from "node:crypto"
import { unlink, writeFile } from "node:fs/promises"
import { Worker } from "bullmq"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import {
  getScanQueueEvents,
  registerScanWorker,
  unregisterScanWorker,
  SCAN_WORKER_HEARTBEAT_MS,
} from "./queue"
import { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "./types"
import { processScanJob } from "./jobs/run-scan.job"
import { startScheduleRunner } from "./schedules"
import {
  assertRepositoryScanRuntimeConfigured,
  terminateActiveEngineProcesses,
} from "./engine/runner"
import { reconcileFailedQueueJob, reconcileScanQueue } from "./queue-reconciliation"
import { assertEvidenceStorageConfigured } from "./engine/evidence-storage"

let worker: Worker<ScanJobData, ScanJobResult> | null = null
let queueEvents: ReturnType<typeof getScanQueueEvents> | null = null
let scheduleRunner: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let reconciliationTimer: NodeJS.Timeout | null = null
let shuttingDown = false
const workerId = `${process.env.HOSTNAME || "worker"}-${process.pid}-${randomUUID()}`
const readinessPath = "/tmp/lyrashield-worker-ready"

async function refreshWorkerReadiness(): Promise<void> {
  await writeFile(readinessPath, new Date().toISOString(), { mode: 0o600 })
}

async function removeWorkerReadiness(): Promise<void> {
  await unlink(readinessPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  logger.info("Worker shutting down", { signal })

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  await removeWorkerReadiness().catch((error) => {
    logger.warn("Could not remove worker readiness marker", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer)
    reconciliationTimer = null
  }
  await unregisterScanWorker(workerId).catch((error) => {
    logger.warn("Could not unregister scan worker", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  const terminatedEngineProcesses = terminateActiveEngineProcesses()
  if (terminatedEngineProcesses > 0) {
    logger.info("Terminating active engine processes", { count: terminatedEngineProcesses })
  }

  if (scheduleRunner) {
    clearInterval(scheduleRunner)
    scheduleRunner = null
    logger.info("Schedule runner stopped")
  }

  if (worker) {
    const closed = worker.close()
    if (!closed) {
      logger.warn("Worker.close() returned null, forcing shutdown")
    } else {
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 25_000)
      )
      if ((await Promise.race([closed.then(() => "closed" as const), timeout])) === "timeout") {
        logger.warn("BullMQ worker close timed out; forcing shutdown")
        process.exit(1)
      }
    }
    logger.info("BullMQ worker closed")
  }

  if (queueEvents) {
    await queueEvents.close()
    logger.info("Queue events closed")
  }

  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

async function main(): Promise<void> {
  logger.info("LyraShield worker starting", { redisConfigured: Boolean(env.REDIS_URL) })
  assertEvidenceStorageConfigured()
  assertRepositoryScanRuntimeConfigured()

  worker = new Worker<ScanJobData, ScanJobResult>(SCAN_QUEUE_NAME, processScanJob, {
    connection: {
      url: env.REDIS_URL || "redis://localhost:6379",
      maxRetriesPerRequest: null,
    },
    concurrency: env.LYRASHIELD_WORKER_CONCURRENCY,
    autorun: false,
  })

  await worker.waitUntilReady()
  queueEvents = getScanQueueEvents()
  await queueEvents.waitUntilReady()
  queueEvents.on("completed", ({ jobId, returnvalue }) => {
    logger.info("Job completed", { jobId, result: returnvalue })
  })
  queueEvents.on("failed", ({ jobId, failedReason }) => {
    logger.error("Job failed in queue", { jobId, reason: failedReason })
    if (jobId) void reconcileFailedQueueJob(jobId, failedReason)
  })

  worker.on("error", (error) => {
    logger.error("Worker error", { error: error.message, stack: error.stack })
  })

  await reconcileScanQueue()
  await registerScanWorker(workerId)
  await refreshWorkerReadiness()
  void worker.run().catch((error) => {
    logger.error("BullMQ worker stopped unexpectedly", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  logger.info("Worker ready — processing scan jobs", {
    queue: SCAN_QUEUE_NAME,
    concurrency: env.LYRASHIELD_WORKER_CONCURRENCY,
  })
  heartbeatTimer = setInterval(() => {
    void registerScanWorker(workerId)
      .then(refreshWorkerReadiness)
      .catch((error) => {
        logger.error("Scan worker heartbeat failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }, SCAN_WORKER_HEARTBEAT_MS)

  reconciliationTimer = setInterval(() => {
    void reconcileScanQueue().catch((error) => {
      logger.error("Scan queue reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, 60_000)

  scheduleRunner = startScheduleRunner()
  logger.info("Schedule runner started", { intervalMs: 60_000 })
}

main().catch((error) => {
  logger.error("Worker failed to start", { error: String(error) })
  process.exit(1)
})
