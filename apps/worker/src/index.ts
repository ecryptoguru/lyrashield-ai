import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { unlink, writeFile } from "node:fs/promises"
import { Worker } from "bullmq"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { registerScanWorker, unregisterScanWorker, SCAN_WORKER_HEARTBEAT_MS } from "./queue"
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
let scheduleRunner: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let shuttingDown = false
const workerId = `${hostname() || process.env.HOSTNAME || "worker"}-${process.pid}-${randomUUID()}`
const readinessPath = "/tmp/lyrashield-worker-ready"
async function refreshWorkerReadiness(): Promise<void> {
  await writeFile(readinessPath, new Date().toISOString(), { mode: 0o600 })
}

async function removeWorkerReadiness(): Promise<void> {
  await unlink(readinessPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
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

  process.exit(exitCode)
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
    // BRPOP blocks for up to 10 min per call — but returns instantly when a
    // job is pushed to the queue. This gives instant scan pickup with only
    // ~4.3K re-issue commands/month at idle. Stalled check is skipped because
    // reconcileScanQueue() runs once on startup and catches orphaned jobs.
    drainDelay: 600,
    skipStalledCheck: true,
  })

  await worker.waitUntilReady()
  worker.on("completed", (job, result) => {
    logger.info("Job completed", { jobId: job.id, result })
    void registerScanWorker(workerId)
      .then(refreshWorkerReadiness)
      .catch(() => {})
  })
  worker.on("failed", (job, error) => {
    logger.error("Job failed in queue", { jobId: job?.id, reason: error.message })
    if (job?.id) void reconcileFailedQueueJob(job.id, error.message)
  })

  worker.on("error", (error) => {
    logger.error("Worker error", { error: error.message, stack: error.stack })
  })

  // One-time sweep on startup — catches orphans from a previous crash.
  // No background timer: reconciliation runs only when the worker starts.
  await reconcileScanQueue()
  await registerScanWorker(workerId)
  await refreshWorkerReadiness()
  void worker.run().catch((error) => {
    logger.error("BullMQ worker stopped unexpectedly", {
      error: error instanceof Error ? error.message : String(error),
    })
    void shutdown("BULLMQ_RUN_FAILURE", 1)
  })
  logger.info("Worker ready — processing scan jobs", {
    queue: SCAN_QUEUE_NAME,
    concurrency: env.LYRASHIELD_WORKER_CONCURRENCY,
  })
  // Minimal heartbeat: every 30 min, just enough to keep /api/ready/scans
  // accurate. Registration is also refreshed after each job completes.
  heartbeatTimer = setInterval(() => {
    void registerScanWorker(workerId)
      .then(refreshWorkerReadiness)
      .catch(async (error) => {
        logger.error("Scan worker heartbeat failed", {
          error: error instanceof Error ? error.message : String(error),
        })
        await removeWorkerReadiness().catch((readinessError) => {
          logger.warn("Could not clear worker readiness after heartbeat failure", {
            error:
              readinessError instanceof Error ? readinessError.message : String(readinessError),
          })
        })
      })
  }, SCAN_WORKER_HEARTBEAT_MS)

  scheduleRunner = startScheduleRunner()
  logger.info("Schedule runner started", { intervalMs: 300_000 })
}

main().catch((error) => {
  logger.error("Worker failed to start", { error: String(error) })
  process.exit(1)
})
