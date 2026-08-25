import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { chmod, readFile, unlink, writeFile } from "node:fs/promises"
import { Worker } from "bullmq"
import { logger } from "@lyrashield/logger"
import { env, resolveWorkerExecutionProvenance } from "@lyrashield/config"
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
import {
  reconcileFailedQueueJob,
  reconcileScanQueue,
  reconcileScanQueueIfNeeded,
  type QueueReconciliationResult,
} from "./queue-reconciliation"
import { assertEvidenceStorageConfigured } from "./engine/evidence-storage"
import { reapStaleScanResources } from "./engine/stale-resource-reaper"
import { observeWorkerRun } from "./worker-lifecycle"
import { collectOperationalHealthSnapshot, evaluateOperationalHealth } from "./operational-health"

let worker: Worker<ScanJobData, ScanJobResult> | null = null
let webhookTrackRetryWorker: Worker<WebhookTrackRetryJobData, void> | null = null
let scheduleRunner: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let workerHeartbeatController: WorkerHeartbeatController | null = null
let egressDrainTimer: NodeJS.Timeout | null = null
let reconciliationTimer: NodeJS.Timeout | null = null
let staleResourceReaperTimer: NodeJS.Timeout | null = null
let billingJobsTimers: NodeJS.Timeout[] | null = null
let approvalExpiryTimer: NodeJS.Timeout | null = null
let shuttingDown = false
const workerId = `${hostname() || process.env.HOSTNAME || "worker"}-${process.pid}-${randomUUID()}`
const readinessPath = "/tmp/lyrashield-worker-ready"
const activeJobPath = "/tmp/lyrashield-worker-active"
const plannedRestartPath = "/tmp/lyrashield-worker-planned-restart"
const egressDrainRequestPath = "/tmp/lyrashield-worker-egress-drain-request"
const egressDrainReadyPath = "/tmp/lyrashield-worker-egress-drain-ready"
const egressDrainTokenPattern = /^[a-f0-9]{64}$/
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

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    // Caller passes only the fixed local handshake paths declared above.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return (await readFile(path, "utf8")).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export async function acknowledgeEgressDrainRequest(
  scanWorker: Pick<Worker, "pause">,
  deactivateScanWorker: () => Promise<void>
): Promise<boolean> {
  const token = await readOptionalFile(egressDrainRequestPath)
  if (token === null) return false
  if (!egressDrainTokenPattern.test(token)) throw new Error("Invalid egress drain request token")
  if ((await readOptionalFile(egressDrainReadyPath)) === token) return true

  // BullMQ sets the local paused flag before waiting for all current jobs, so
  // no new scan claim can race the matching acknowledgement written below.
  let paused: Promise<void>
  try {
    paused = scanWorker.pause()
  } catch (error) {
    await deactivateScanWorker()
    throw error
  }
  await deactivateScanWorker()
  await paused
  if ((await readOptionalFile(egressDrainRequestPath)) !== token) {
    throw new Error("Egress drain request changed before acknowledgement")
  }
  await writeFile(egressDrainReadyPath, token, { mode: 0o600 })
  await chmod(egressDrainReadyPath, 0o600)
  return true
}

export async function deactivateScanWorkerForDrain(
  heartbeatController: Pick<WorkerHeartbeatController, "stop">,
  unregisterWorker: () => Promise<void>,
  removeReadiness: () => Promise<void>
): Promise<void> {
  // stop() disables new completion/timer heartbeats synchronously, then waits
  // for any registration already in flight before this worker is removed.
  const heartbeatsStopped = heartbeatController.stop()
  let readinessError: unknown
  try {
    await removeReadiness()
  } catch (error) {
    readinessError = error
  }
  await heartbeatsStopped
  await unregisterWorker()
  if (readinessError) throw readinessError
}

export async function failClosedAfterEgressDrainCancellation(
  shutdownDrainedWorker: () => Promise<void>
): Promise<boolean> {
  if ((await readOptionalFile(egressDrainRequestPath)) !== null) return false
  await unlink(egressDrainReadyPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  // pause() has already waited for every active scan. Exiting through the
  // normal shutdown path lets systemd Restart=always create a fresh process
  // whose BullMQ run promise is observed from its first loop onward.
  await shutdownDrainedWorker()
  return true
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

export async function finalizeScanWorkerRegistrationForShutdown(
  plannedRestart: boolean,
  heartbeatsStopped: boolean,
  retainHandoff: () => Promise<void>,
  unregisterWorker: () => Promise<void>
): Promise<"handoff" | "unregistered" | "skipped"> {
  // An unsettled heartbeat can still re-register this exact member. Do not
  // race it with a handoff or unregister mutation; let its bounded TTL expire.
  if (!heartbeatsStopped) return "skipped"
  if (plannedRestart) {
    await retainHandoff()
    return "handoff"
  }
  await unregisterWorker()
  return "unregistered"
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
  if (egressDrainTimer) {
    clearInterval(egressDrainTimer)
    egressDrainTimer = null
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

  const registrationAction = await finalizeScanWorkerRegistrationForShutdown(
    plannedRestart,
    heartbeatsStopped,
    () =>
      handoffScanWorker(workerId).catch((error) => {
        logger.warn("Could not retain scan-worker handoff lease", {
          error: error instanceof Error ? error.message : String(error),
        })
      }),
    () =>
      unregisterScanWorker(workerId).catch((error) => {
        logger.warn("Could not unregister scan worker", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  )
  if (registrationAction === "handoff") {
    logger.info("Retaining scan-worker handoff lease for planned restart", {
      graceMs: SCAN_WORKER_RESTART_GRACE_MS,
    })
  } else if (registrationAction === "skipped") {
    logger.warn("Skipping scan-worker registry update after heartbeat shutdown timeout", {
      plannedRestart,
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

  // Reconcile unconditionally on startup. Every five minutes thereafter, use the
  // database to avoid Redis queue inspection while idle, with an hourly backstop.
  // The distributed lease inside reconcileScanQueue() keeps replicas safe.
  const startupReconciliation = await reconcileScanQueue()
  let lastReconciliationAtMs = Date.now()
  await emitOperationalHealthAlerts(startupReconciliation).catch((error) => {
    logger.warn("Operational health collection failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  reconciliationTimer = setInterval(() => {
    const now = new Date()
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
  let egressDrainCheckInFlight = false
  let egressDrainAcknowledged = false
  egressDrainTimer = setInterval(() => {
    if (!worker || egressDrainCheckInFlight) return
    egressDrainCheckInFlight = true
    void acknowledgeEgressDrainRequest(worker, async () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      await deactivateScanWorkerForDrain(
        scanWorkerHeartbeat,
        () => unregisterScanWorker(workerId),
        removeWorkerReadiness
      )
    })
      .then(async (acknowledged) => {
        if (acknowledged) {
          egressDrainAcknowledged = true
          return
        }
        if (!egressDrainAcknowledged || !worker) return
        if (
          await failClosedAfterEgressDrainCancellation(() =>
            shutdown("EGRESS_REFRESH_CANCELLED", 1)
          )
        ) {
          egressDrainAcknowledged = false
          logger.info("Drained worker stopped after cancelled egress refresh")
        }
      })
      .catch((error) => {
        logger.warn("Worker egress drain handshake failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        egressDrainCheckInFlight = false
      })
  }, 1_000)
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
