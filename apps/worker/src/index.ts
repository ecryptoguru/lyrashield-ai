import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { unlink, writeFile } from "node:fs/promises"
import { Worker } from "bullmq"
import { logger } from "@lyrashield/logger"
import { env } from "@lyrashield/config"
import {
  registerScanWorker,
  handoffScanWorker,
  unregisterScanWorker,
  SCAN_WORKER_HEARTBEAT_MS,
  SCAN_WORKER_RESTART_GRACE_MS,
  WEBHOOK_TRACK_RETRY_QUEUE_NAME,
  type WebhookTrackRetryJobData,
} from "@lyrashield/integrations"
import { dispatch as dispatchAffiliate } from "@lyrashield/affiliate"
import { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "./types"
import { processScanJob } from "./jobs/run-scan.job"
import { processWebhookTrackRetry } from "./jobs/webhook-track-retry.job"
import { startScheduleRunner } from "./schedules"
import { startBillingJobsScheduler } from "./billing-jobs-scheduler"
import { startApprovalExpiryRunner } from "./approval-expiry"
import { checkScanConsumerLiveness, markScanJobClaimed } from "./consumer-liveness"
import {
  assertRepositoryScanRuntimeConfigured,
  terminateActiveEngineProcesses,
} from "./engine/runner"
import { reconcileFailedQueueJob, reconcileScanQueue } from "./queue-reconciliation"
import { assertEvidenceStorageConfigured } from "./engine/evidence-storage"
import { reapStaleScanResources } from "./engine/stale-resource-reaper"
import { observeWorkerRun } from "./worker-lifecycle"

let worker: Worker<ScanJobData, ScanJobResult> | null = null
let webhookTrackRetryWorker: Worker<WebhookTrackRetryJobData, void> | null = null
let scheduleRunner: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let reconciliationTimer: NodeJS.Timeout | null = null
let staleResourceReaperTimer: NodeJS.Timeout | null = null
let billingJobsTimers: NodeJS.Timeout[] | null = null
let approvalExpiryTimer: NodeJS.Timeout | null = null
let shuttingDown = false
const workerId = `${hostname() || process.env.HOSTNAME || "worker"}-${process.pid}-${randomUUID()}`
const readinessPath = "/tmp/lyrashield-worker-ready"
const activeJobPath = "/tmp/lyrashield-worker-active"
const plannedRestartPath = "/tmp/lyrashield-worker-planned-restart"
export const RECONCILIATION_INTERVAL_MS = 300_000

// Sentry is optional and a no-op unless SENTRY_DSN is set. Dynamically imported
// so the dependency is only loaded when configured.
//
// FOLLOW-UP (observability): route queue-reconciliation drift and cleanup_failed
// events to Sentry (e.g. captureMessage with a fingerprint) so silent divergence
// between the BullMQ queue and the database is alerted on, not just logged.
async function initSentry(): Promise<void> {
  if (!env.SENTRY_DSN) return
  try {
    const Sentry = await import("@sentry/node")
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: 0.1,
    })
    logger.info("Sentry initialised for worker")
  } catch (error) {
    logger.warn("Failed to initialise Sentry; continuing without it", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function refreshWorkerReadiness(): Promise<void> {
  await writeFile(readinessPath, new Date().toISOString(), { mode: 0o600 })
}

export async function removeWorkerReadiness(): Promise<void> {
  await unlink(readinessPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
}

export async function markWorkerActive(jobId: string): Promise<void> {
  await writeFile(activeJobPath, jobId, { mode: 0o600 })
}

export async function clearWorkerActive(): Promise<void> {
  await unlink(activeJobPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
}

async function consumePlannedRestart(): Promise<boolean> {
  try {
    await unlink(plannedRestartPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    logger.warn("Could not consume planned worker restart marker", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const plannedRestart = await consumePlannedRestart()

  logger.info("Worker shutting down", { signal })

  // Stop periodic work first so the worker cannot be handed new jobs while
  // it is closing. The schedule runner can enqueue new scans; the heartbeat
  // can re-register this worker after we have tried to unregister it.
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer)
    reconciliationTimer = null
  }
  if (staleResourceReaperTimer) {
    clearInterval(staleResourceReaperTimer)
    staleResourceReaperTimer = null
  }
  if (billingJobsTimers) {
    for (const timer of billingJobsTimers) {
      clearInterval(timer)
    }
    billingJobsTimers = null
    logger.info("Billing jobs scheduler stopped")
  }
  if (approvalExpiryTimer) {
    clearInterval(approvalExpiryTimer)
    approvalExpiryTimer = null
    logger.info("Approval expiry runner stopped")
  }
  if (scheduleRunner) {
    clearInterval(scheduleRunner)
    scheduleRunner = null
    logger.info("Schedule runner stopped")
  }

  // Close the BullMQ worker before terminating engine processes. Once closed,
  // no new jobs are accepted; active jobs are allowed to finish or are timed
  // out, and then any remaining engine child processes are killed.
  if (worker) {
    const closed = worker.close()
    const localWorker = worker
    worker = null
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
    logger.info("BullMQ worker closed", { workerId: localWorker.id })
  }

  // Close the webhook-track retry worker the same way — no new retry jobs are
  // accepted once closing starts; in-flight track retries finish or time out.
  if (webhookTrackRetryWorker) {
    const retryClosed = webhookTrackRetryWorker.close()
    webhookTrackRetryWorker = null
    await Promise.race([
      retryClosed.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
    ])
    logger.info("Webhook track retry worker closed")
  }

  const terminatedEngineProcesses = terminateActiveEngineProcesses()
  if (terminatedEngineProcesses > 0) {
    logger.info("Terminating active engine processes", { count: terminatedEngineProcesses })
  }

  if (plannedRestart) {
    await handoffScanWorker(workerId).catch((error) => {
      logger.warn("Could not retain scan-worker handoff lease", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    logger.info("Retaining scan-worker handoff lease for planned restart", {
      graceMs: SCAN_WORKER_RESTART_GRACE_MS,
    })
  } else {
    await unregisterScanWorker(workerId).catch((error) => {
      logger.warn("Could not unregister scan worker", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  await removeWorkerReadiness().catch((error) => {
    logger.warn("Could not remove worker readiness marker", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  process.exit(exitCode)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

async function main(): Promise<void> {
  await initSentry()
  logger.info("LyraShield worker starting", { redisConfigured: Boolean(env.REDIS_URL) })
  assertEvidenceStorageConfigured()
  assertRepositoryScanRuntimeConfigured()

  worker = new Worker<ScanJobData, ScanJobResult>(
    SCAN_QUEUE_NAME,
    async (job) => {
      // Record the claim at the top of the processor so the liveness guard can
      // tell "consumer is alive and claiming" apart from "wedged with work waiting".
      markScanJobClaimed()
      await markWorkerActive(job.id ?? "unknown")
      try {
        return await processScanJob(job)
      } finally {
        await clearWorkerActive()
      }
    },
    {
      connection: {
        url: env.REDIS_URL || "redis://localhost:6379",
        maxRetriesPerRequest: null,
      },
      concurrency: env.LYRASHIELD_WORKER_CONCURRENCY,
      autorun: false,
      // BRPOP blocks for up to 10 min per call — but returns instantly when a
      // job is pushed to the queue. This gives instant scan pickup with only
      // ~4.3K re-issue commands/month at idle. Stalled checks run every minute
      // so jobs that are genuinely stuck are retried; reconcileScanQueue() is the
      // fail-closed backstop that runs both on startup and periodically. The
      // consumer-liveness guard (below) covers the remaining failure mode: the
      // blocking client silently wedging (taskforcesh/bullmq#4479) so jobs sit
      // in `wait` while the worker reports ready.
      drainDelay: 600,
      stalledInterval: 60_000,
    }
  )

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

  // Webhook required-track retries (findings 12 / 18A). Separate BullMQ queue
  // + worker sharing the same connection options; the processor delegates to
  // the shared executor in @lyrashield/billing via injected handlers.
  webhookTrackRetryWorker = new Worker<WebhookTrackRetryJobData, void>(
    WEBHOOK_TRACK_RETRY_QUEUE_NAME,
    async (job) => {
      const result = await processWebhookTrackRetry(job, { dispatchAffiliate })
      logger.info("Webhook track retry processed", {
        jobId: job.id,
        webhookEventId: job.data.webhookEventId,
        track: job.data.track,
        outcome: result.outcome,
        reEnqueued: result.reEnqueued,
      })
    },
    {
      connection: {
        url: env.REDIS_URL || "redis://localhost:6379",
        maxRetriesPerRequest: null,
      },
      concurrency: 2,
      autorun: false,
    }
  )
  await webhookTrackRetryWorker.waitUntilReady()
  webhookTrackRetryWorker.on("failed", (job, error) => {
    logger.error("Webhook track retry job failed in queue", {
      jobId: job?.id,
      webhookEventId: job?.data?.webhookEventId,
      track: job?.data?.track,
      reason: error.message,
    })
  })
  webhookTrackRetryWorker.on("error", (error) => {
    logger.error("Webhook track retry worker error", { error: error.message })
  })
  webhookTrackRetryWorker.run().catch((error) => {
    logger.error("Webhook track retry worker stopped unexpectedly", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  // Reconcile once on startup and then every five minutes. The distributed lease
  // inside reconcileScanQueue() ensures only one worker acts per interval.
  await reconcileScanQueue()
  reconciliationTimer = setInterval(() => {
    void reconcileScanQueue()
      .then(async () => {
        // Consumer-liveness guard: if jobs are waiting in the scan queue but
        // this consumer has not claimed one within the blocking window + grace,
        // the BullMQ blocking fetch loop is presumed wedged
        // (taskforcesh/bullmq#4479 — silently not consuming after a transient
        // Redis reset). Fail closed so systemd `Restart=always` re-attaches a
        // healthy consumer. A null result (Redis unavailable) is "no signal" and
        // never triggers a restart.
        if (!worker || shuttingDown) return
        const liveness = await checkScanConsumerLiveness()
        if (liveness?.wedged) {
          logger.error(
            "Scan consumer wedged: jobs waiting but none claimed within the blocking window; restarting to re-attach",
            { waiting: liveness.waiting, idleForMs: liveness.idleForMs }
          )
          await shutdown("CONSUMER_WEDGED", 1)
        }
      })
      .catch((error) => {
        logger.warn("Periodic scan queue reconciliation failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }, RECONCILIATION_INTERVAL_MS)
  if (env.LYRASHIELD_STALE_RESOURCE_REAPER_ENABLED === "1") {
    const reap = async () => {
      const result = await reapStaleScanResources({
        minimumAgeMs: env.LYRASHIELD_STALE_RESOURCE_MIN_AGE_MINUTES * 60_000,
      })
      logger.info("Stale-resource reaper completed", { ...result })
    }
    await reap().catch((error) => {
      logger.warn("Stale-resource reaper failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    staleResourceReaperTimer = setInterval(() => {
      void reap().catch((error) => {
        logger.warn("Stale-resource reaper failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, env.LYRASHIELD_STALE_RESOURCE_REAPER_INTERVAL_MS)
  }
  await registerScanWorker(workerId)
  await refreshWorkerReadiness()
  observeWorkerRun(worker.run(), (termination) => {
    logger.error("BullMQ worker stopped unexpectedly", {
      reason: termination.reason,
      ...("error" in termination
        ? {
            error:
              termination.error instanceof Error
                ? termination.error.message
                : String(termination.error),
          }
        : {}),
    })
    void shutdown(termination.reason, 1)
  })
  logger.info("Worker ready — processing scan jobs", {
    queue: SCAN_QUEUE_NAME,
    concurrency: env.LYRASHIELD_WORKER_CONCURRENCY,
  })
  // Refresh every two minutes, leaving more than one missed interval before
  // the five-minute worker registration expires. Jobs also refresh it on completion.
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
  logger.info("Schedule runner started", { intervalMs: 60_000 })

  billingJobsTimers = startBillingJobsScheduler()

  approvalExpiryTimer = startApprovalExpiryRunner()
}

if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  main().catch((error) => {
    logger.error("Worker failed to start", { error: String(error) })
    process.exit(1)
  })
}
