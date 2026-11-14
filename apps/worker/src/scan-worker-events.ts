import type { Worker } from "bullmq"
import { logger } from "@lyrashield/logger"
import { reconcileFailedQueueJob } from "./queue-reconciliation"
import type { ScanJobData, ScanJobResult } from "./types"

export function attachScanWorkerErrorHandlers(worker: Worker<ScanJobData, ScanJobResult>) {
  worker.on("failed", (job, error) => {
    logger.error("Job failed in queue", { jobId: job?.id, reason: error.message })
    if (job?.id) {
      void reconcileFailedQueueJob(job.id, error.message, job.attemptsMade, job.opts.attempts ?? 1)
    }
  })

  worker.on("error", (error) => {
    logger.error("Worker error", { error: error.message, stack: error.stack })
  })
}
