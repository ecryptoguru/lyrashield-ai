import { Worker } from "bullmq"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import { getScanQueueEvents } from "./queue"
import { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "./types"
import { processScanJob } from "./jobs/run-scan.job"
import { startScheduleRunner } from "./schedules"
import { terminateActiveEngineProcesses } from "./engine/runner"

let worker: Worker<ScanJobData, ScanJobResult> | null = null
let queueEvents: ReturnType<typeof getScanQueueEvents> | null = null
let scheduleRunner: NodeJS.Timeout | null = null
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  logger.info("Worker shutting down", { signal })

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
  logger.info("LyraShield worker starting", { redisUrl: env.REDIS_URL || "redis://localhost:6379" })

  worker = new Worker<ScanJobData, ScanJobResult>(SCAN_QUEUE_NAME, processScanJob, {
    connection: {
      url: env.REDIS_URL || "redis://localhost:6379",
      maxRetriesPerRequest: null,
    },
    concurrency: 3,
  })

  queueEvents = getScanQueueEvents()
  queueEvents.on("completed", ({ jobId, returnvalue }) => {
    logger.info("Job completed", { jobId, result: returnvalue })
  })
  queueEvents.on("failed", ({ jobId, failedReason }) => {
    logger.error("Job failed in queue", { jobId, reason: failedReason })
  })

  worker.on("ready", () => {
    logger.info("Worker ready — processing scan jobs", { queue: SCAN_QUEUE_NAME, concurrency: 3 })
  })

  worker.on("error", (error) => {
    logger.error("Worker error", { error: error.message, stack: error.stack })
  })

  scheduleRunner = startScheduleRunner()
  logger.info("Schedule runner started", { intervalMs: 60_000 })
}

main().catch((error) => {
  logger.error("Worker failed to start", { error: String(error) })
  process.exit(1)
})
