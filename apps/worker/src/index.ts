import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { unlink, writeFile } from "node:fs/promises"
import { Worker } from "bullmq"
import { logger } from "@lyrashield/logger"
import { env, resolveWorkerExecutionProvenance } from "@lyrashield/config"
import {
  registerScanWorker,
  unregisterScanWorker,
  SCAN_WORKER_HEARTBEAT_MS,
  WEBHOOK_TRACK_RETRY_QUEUE_NAME,
  type WebhookTrackRetryJobData,
} from "@lyrashield/integrations"
import { dispatch as dispatchAffiliate } from "@lyrashield/affiliate"
import { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "./types"
import { processScanJob } from "./jobs/run-scan.job"
import { processWebhookTrackRetry } from "./jobs/webhook-track-retry.job"
import {
  FIX_GENERATE_QUEUE,
  processFixGenerateJob,
  type FixGenerateJobData,
  type FixGenerateJobResult,
} from "./jobs/fix-generate.job"
import { startScheduleRunner } from "./schedules"
import { startBillingJobsScheduler } from "./billing-jobs-scheduler"
import { startApprovalExpiryRunner } from "./approval-expiry"
import { checkScanConsumerLiveness, markScanJobClaimed } from "./consumer-liveness"
import {
  assertRepositoryScanRuntimeConfigured,
  terminateActiveEngineProcesses,
} from "./engine/runner"
import {
  reconcileFailedQueueJob,
  reconcileScanQueue,
  reconcileScanQueueIfNeeded,
  type QueueReconciliationResult,
} from "./queue-reconciliation"
import { assertEvidenceStorageConfigured } from "./engine/evidence-storage"
import { drainArtifactDeletionTasks } from "@lyrashield/evidence-storage"
import { assertEngineTempRootReady } from "./engine/workspace-path"
import { reapStaleScanResources } from "./engine/stale-resource-reaper"
import { observeWorkerRun } from "./worker-lifecycle"
import { collectOperationalHealthSnapshot, evaluateOperationalHealth } from "./operational-health"

let worker: Worker<ScanJobData, ScanJobResult> | null = null
let webhookTrackRetryWorker: Worker<WebhookTrackRetryJobData, void> | null = null
let scheduleRunner: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let workerHeartbeatController: WorkerHeartbeatController | null = null
let reconciliationTimer: NodeJS.Timeout | null = null
let staleResourceReaperTimer: NodeJS.Timeout | null = null
let billingJobsTimers: NodeJS.Timeout[] | null = null
let approvalExpiryTimer: NodeJS.Timeout | null = null
let shuttingDown = false
const workerId = `${hostname() || process.env.HOSTNAME || "worker"}-${process.pid}-${randomUUID()}`
const readinessPath = "/tmp/lyrashield-worker-ready"
const activeJobPath = "/tmp/lyrashield-worker-active"
export const RECONCILIATION_INTERVAL_MS = 300_000
export const MANAGED_REDIS_DRAIN_DELAY_SECONDS = 600
export const MANAGED_REDIS_STALLED_INTERVAL_MS = 60_000

export function advanceReconciliationTimestamp(currentMs: number, completedTickMs: number): number {
  return Math.max(currentMs, completedTickMs)
}

interface WorkerHeartbeatController {
  heartbeat(): Promise<void>
  stop(): Promise<void>
}

export function createWorkerHeartbeatController(
  register: () => Promise<void>,
  markReady: () => Promise<void>
): WorkerHeartbeatController {
  let stopped = false
  const inFlight = new Set<Promise<void>>()

  return {
    heartbeat() {
      if (stopped) return Promise.resolve()
      const operation = register().then(async () => {
        if (!stopped) await markReady()
      })
      inFlight.add(operation)
      void operation.then(
        () => inFlight.delete(operation),
        () => inFlight.delete(operation)
      )
      return operation
    },
    async stop() {
      stopped = true
      await Promise.allSettled([...inFlight])
    },
  }
}

// Sentry is optional and a no-op unless SENTRY_DSN is set. Dynamically imported
// so the dependency is only loaded when configured.
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

export async function emitOperationalHealthAlerts(
  reconciliation: QueueReconciliationResult,
  now = new Date()
): Promise<void> {
  if (!reconciliation.leaseAcquired) return
  const snapshot = await collectOperationalHealthSnapshot({
    now,
    queueDepth: reconciliation.queueDepth,
    oldestWaitingJobAgeMs: reconciliation.oldestWaitingJobAgeMs,
    workerConcurrency: env.LYRASHIELD_WORKER_CONCURRENCY,
    reconciliationDriftCount:
      reconciliation.failedOrphanedScans + reconciliation.removedOrphanedJobs,
  })
  for (const alert of evaluateOperationalHealth(snapshot)) {
    logger.warn("operator_alert", { ...alert })
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

export async function settleScanWorkerForShutdown(
  closePromise: Promise<void> | null | undefined,
  timeoutMs = 25_000
): Promise<boolean> {
  const terminatedEngineProcesses = terminateActiveEngineProcesses()
  if (terminatedEngineProcesses > 0) {
    logger.info("Terminating active engine processes", { count: terminatedEngineProcesses })
  }
  if (!closePromise) return false

  return (
    (await Promise.race([
      closePromise.then(
        () => "closed" as const,
        () => "failed" as const
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
    ])) === "closed"
  )
}

export async function settleScanWorkerLifecycleForShutdown(
  heartbeatController: Pick<WorkerHeartbeatController, "stop"> | null,
  closeWorker: (() => Promise<void> | null | undefined) | null,
  timeoutMs = 25_000
): Promise<{ workerClosed: boolean; heartbeatsStopped: boolean }> {
  // stop() synchronously disables future heartbeats before close() stops new
  // claims. Both settlements then share the same bounded shutdown window.
  const heartbeatsStopped = heartbeatController
    ? Promise.race([
        heartbeatController.stop().then(
          () => true,
          () => false
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ])
    : Promise.resolve(true)
  const workerClosed = settleScanWorkerForShutdown(closeWorker?.(), timeoutMs)
  const [closed, stopped] = await Promise.all([workerClosed, heartbeatsStopped])
  return { workerClosed: closeWorker ? closed : true, heartbeatsStopped: stopped }
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
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

  let forcedExit = false

  // Closing stops new claims. Terminate active engines immediately so paid work
  // cannot outlive the worker while close waits for processors to settle.
  const localWorker = worker
  const scanWorkerSettlement = settleScanWorkerLifecycleForShutdown(
    workerHeartbeatController,
    localWorker ? () => localWorker.close() : null
  )
  workerHeartbeatController = null
  if (localWorker) {
    worker = null
  }
  const { workerClosed, heartbeatsStopped } = await scanWorkerSettlement
  if (!heartbeatsStopped) {
    forcedExit = true
    logger.warn("Worker heartbeat did not settle before shutdown timeout")
  }
  if (localWorker) {
    if (!workerClosed) {
      forcedExit = true
      logger.warn("BullMQ worker did not close cleanly; forcing shutdown")
    } else {
      logger.info("BullMQ worker closed", { workerId: localWorker.id })
    }
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

  if (heartbeatsStopped) {
    await unregisterScanWorker(workerId).catch((error) => {
      logger.warn("Could not unregister scan worker", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  } else {
    logger.warn("Skipping scan-worker registry update after heartbeat shutdown timeout", {
      workerId,
    })
  }
  await removeWorkerReadiness().catch((error) => {
    logger.warn("Could not remove worker readiness marker", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  process.exit(forcedExit ? 1 : exitCode)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

/**
 * Fail-closed worker startup provenance gate. main() calls this before any
 * Worker construction, readiness marker write, or scan lease registration, so
 * a production worker without exact product/image/engine identity never
 * becomes ready and never accepts paid work.
 */
export function assertWorkerStartupProvenance() {
  return resolveWorkerExecutionProvenance()
}

async function main(): Promise<void> {
  await initSentry()
  // Gate readiness BEFORE the worker can claim anything: missing or malformed
  // provenance throws, main() rejects, and the process exits without ever
  // writing the readiness marker.
  assertWorkerStartupProvenance()
  logger.info("LyraShield worker starting", { redisConfigured: Boolean(env.REDIS_URL) })
  assertEvidenceStorageConfigured()
  assertRepositoryScanRuntimeConfigured()
  await assertEngineTempRootReady()

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
      drainDelay: MANAGED_REDIS_DRAIN_DELAY_SECONDS,
      stalledInterval: MANAGED_REDIS_STALLED_INTERVAL_MS,
    }
  )

  await worker.waitUntilReady()
  const scanWorkerHeartbeat = createWorkerHeartbeatController(
    () => registerScanWorker(workerId),
    refreshWorkerReadiness
  )
  workerHeartbeatController = scanWorkerHeartbeat
  worker.on("completed", (job, result) => {
    logger.info("Job completed", { jobId: job.id, result })
    void scanWorkerHeartbeat.heartbeat().catch(() => {})
  })
  worker.on("failed", (job, error) => {
    logger.error("Job failed in queue", { jobId: job?.id, reason: error.message })
    if (job?.id) {
      void reconcileFailedQueueJob(job.id, error.message, job.attemptsMade, job.opts.attempts ?? 1)
    }
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
      // Keep instant job pickup while avoiding BullMQ's five-second idle poll,
      // which alone exceeds a 500,000-command monthly managed Redis budget.
      drainDelay: MANAGED_REDIS_DRAIN_DELAY_SECONDS,
      stalledInterval: MANAGED_REDIS_STALLED_INTERVAL_MS,
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

  // WP3 fix-PR producer: assembles a validated patch from a finding's
  // engine-emitted structured fix and stores it for the approval-bound PR flow.
  fixGenerateWorker = new Worker<FixGenerateJobData, FixGenerateJobResult>(
    FIX_GENERATE_QUEUE,
    async (job) => {
      const result = await processFixGenerateJob(job.data)
      logger.info("Fix generation job processed", {
        jobId: job.id,
        fixProposalId: job.data.fixProposalId,
        status: result.status,
      })
      return result
    },
    {
      connection: {
        url: env.REDIS_URL || "redis://localhost:6379",
        maxRetriesPerRequest: null,
      },
      concurrency: 2,
      autorun: false,
      drainDelay: MANAGED_REDIS_DRAIN_DELAY_SECONDS,
      stalledInterval: MANAGED_REDIS_STALLED_INTERVAL_MS,
    }
  )
  await fixGenerateWorker.waitUntilReady()
  fixGenerateWorker.on("failed", (job, error) => {
    logger.error("Fix generation job failed in queue", {
      jobId: job?.id,
      fixProposalId: job?.data?.fixProposalId,
      reason: error.message,
    })
  })
  fixGenerateWorker.run().catch((error) => {
    logger.error("Fix generation worker stopped unexpectedly", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  // Reconcile unconditionally on startup. Every five minutes thereafter, use the
  // database to avoid Redis queue inspection while idle, with an hourly backstop.
  // The distributed lease inside reconcileScanQueue() keeps replicas safe.
  void drainArtifactDeletionTasks()
    .then((result) => {
      if (result.claimed > 0) {
        logger.info("Artifact deletion outbox drained on startup", { ...result })
      }
    })
    .catch((error) => {
      logger.warn("Artifact deletion outbox startup drain failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  const startupReconciliation = await reconcileScanQueue()
  let lastReconciliationAtMs = Date.now()
  await emitOperationalHealthAlerts(startupReconciliation).catch((error) => {
    logger.warn("Operational health collection failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  reconciliationTimer = setInterval(() => {
    const now = new Date()
    void drainArtifactDeletionTasks()
      .then((result) => {
        if (result.claimed > 0) logger.info("Artifact deletion outbox drained", { ...result })
      })
      .catch((error) => {
        logger.warn("Artifact deletion outbox drain failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    void reconcileScanQueueIfNeeded(lastReconciliationAtMs, now)
      .then(async (reconciliation) => {
        if (!reconciliation) return
        lastReconciliationAtMs = advanceReconciliationTimestamp(
          lastReconciliationAtMs,
          now.getTime()
        )
        await emitOperationalHealthAlerts(reconciliation).catch((error) => {
          logger.warn("Operational health collection failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        })
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
  await scanWorkerHeartbeat.heartbeat()
  observeWorkerRun(worker.run(), (termination) => {
    if (worker?.isPaused()) {
      logger.info("BullMQ worker paused for egress refresh")
      return
    }
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
    if (worker?.isPaused()) {
      void removeWorkerReadiness().catch(() => {})
      return
    }
    void scanWorkerHeartbeat.heartbeat().catch(async (error) => {
      logger.error("Scan worker heartbeat failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      await removeWorkerReadiness().catch((readinessError) => {
        logger.warn("Could not clear worker readiness after heartbeat failure", {
          error: readinessError instanceof Error ? readinessError.message : String(readinessError),
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
