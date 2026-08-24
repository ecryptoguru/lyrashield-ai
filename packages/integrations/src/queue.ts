import { Queue } from "bullmq"
import { env } from "@lyrashield/config"
import { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "@lyrashield/types"
import { getRedis } from "./redis"

const SCAN_WORKER_REGISTRY_KEY = "lyrashield:scan-workers"
export const SCAN_ADMISSION_STOP_KEY = "lyrashield:scan-admission:stopped"
export const SCAN_WORKER_HEARTBEAT_MS = 120_000
export const SCAN_WORKER_TTL_MS = 300_000
export const SCAN_WORKER_RESTART_GRACE_MS = 60_000

export class ScanWorkerUnavailableError extends Error {
  readonly code = "SCAN_SERVICE_UNAVAILABLE"

  constructor() {
    super("No scan worker is currently available")
    this.name = "ScanWorkerUnavailableError"
  }
}

function requireRedis() {
  const redis = getRedis()
  if (!redis) throw new ScanWorkerUnavailableError()
  return redis
}

type ScanWorkerRedis = ReturnType<typeof requireRedis> & {
  scanWorkerHeartbeat(
    key: string,
    now: number,
    expiresAt: number,
    workerId: string,
    keyTtl: number
  ): Promise<number>
  scanWorkerReadiness(key: string, now: number): Promise<number>
}

function getScanWorkerRedis(): ScanWorkerRedis {
  const redis = requireRedis() as ScanWorkerRedis

  if (!redis.scanWorkerHeartbeat) {
    redis.defineCommand("scanWorkerHeartbeat", {
      numberOfKeys: 1,
      lua: `
        redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
        redis.call("ZADD", KEYS[1], ARGV[2], ARGV[3])
        return redis.call("PEXPIRE", KEYS[1], ARGV[4])
      `,
    })
  }

  if (!redis.scanWorkerReadiness) {
    redis.defineCommand("scanWorkerReadiness", {
      numberOfKeys: 1,
      lua: `
        redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
        return redis.call("ZCARD", KEYS[1])
      `,
    })
  }

  return redis
}

export async function registerScanWorker(workerId: string, now = Date.now()): Promise<void> {
  const redis = getScanWorkerRedis()
  await redis.scanWorkerHeartbeat(
    SCAN_WORKER_REGISTRY_KEY,
    now,
    now + SCAN_WORKER_TTL_MS,
    workerId,
    SCAN_WORKER_TTL_MS * 2
  )
}

export async function unregisterScanWorker(workerId: string): Promise<void> {
  const redis = requireRedis()
  await redis.zrem(SCAN_WORKER_REGISTRY_KEY, workerId)
}

/**
 * Keep a short lease while an operator-initiated restart hands work to the
 * replacement process. Crashes still unregister/expire normally.
 */
export async function handoffScanWorker(workerId: string, now = Date.now()): Promise<void> {
  const redis = requireRedis()
  await redis.zadd(SCAN_WORKER_REGISTRY_KEY, now + SCAN_WORKER_RESTART_GRACE_MS, workerId)
}

export async function isScanWorkerAvailable(now = Date.now()): Promise<boolean> {
  if (!getRedis()) return false

  try {
    const workers = await getScanWorkerRedis().scanWorkerReadiness(SCAN_WORKER_REGISTRY_KEY, now)
    // Managed Redis proxies do not reliably expose other clients' names via
    // CLIENT LIST, which makes BullMQ getWorkersCount() connection-dependent.
    // The worker owns this short-lived registration, removes it on shutdown,
    // and clears readiness when its heartbeat fails.
    return Number(workers) > 0
  } catch {
    return false
  }
}

export async function assertScanWorkerAvailable(): Promise<void> {
  const redis = getRedis()
  if (!redis) throw new ScanWorkerUnavailableError()

  try {
    // This key is in a different Redis Cluster slot from the worker registry.
    if ((await redis.exists(SCAN_ADMISSION_STOP_KEY)) > 0) {
      throw new ScanWorkerUnavailableError()
    }
  } catch (error) {
    if (error instanceof ScanWorkerUnavailableError) throw error
    // Admission state is authoritative. Redis uncertainty must fail closed.
    throw new ScanWorkerUnavailableError()
  }

  if (!(await isScanWorkerAvailable())) throw new ScanWorkerUnavailableError()
}

function getConnectionOpts() {
  return {
    url: env.REDIS_URL || "redis://localhost:6379",
    maxRetriesPerRequest: null as number | null,
  }
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: "exponential" as const,
    delay: 5_000,
  },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 200 },
}

let scanQueue: Queue<ScanJobData, ScanJobResult> | null = null

export function getScanQueue(): Queue<ScanJobData, ScanJobResult> {
  if (!scanQueue) {
    scanQueue = new Queue<ScanJobData, ScanJobResult>(SCAN_QUEUE_NAME, {
      connection: getConnectionOpts(),
      defaultJobOptions,
    })
  }
  return scanQueue
}

export async function enqueueScan(data: ScanJobData): Promise<string> {
  await assertScanWorkerAvailable()
  const queue = getScanQueue()
  const job = await queue.add("scan", data, { jobId: data.scanId })
  return job.id!
}

/**
 * Durable retry queue for failed webhook required-tracks (findings 12 / 18A).
 *
 * One BullMQ queue owned here (single connection factory, like the scan
 * queue); the WebhookEventTrack DB row owns attempt counting and
 * dead-lettering, so BullMQ-level attempts stay at 1 and a transient worker
 * crash can never double-count the budget.
 */
export const WEBHOOK_TRACK_RETRY_QUEUE_NAME = "webhook-track-retry"

export interface WebhookTrackRetryJobData {
  webhookEventId: string
  /** "billing" | "license" | "affiliate" */
  track: string
}

let webhookTrackRetryQueue: Queue<WebhookTrackRetryJobData, void> | null = null

export function getWebhookTrackRetryQueue(): Queue<WebhookTrackRetryJobData, void> {
  if (!webhookTrackRetryQueue) {
    webhookTrackRetryQueue = new Queue<WebhookTrackRetryJobData, void>(
      WEBHOOK_TRACK_RETRY_QUEUE_NAME,
      {
        connection: getConnectionOpts(),
        defaultJobOptions,
      }
    )
  }
  return webhookTrackRetryQueue
}

/**
 * Enqueue a retry for one webhook track. jobId = `<eventId>:<track>` so
 * concurrent/repeated enqueues for the same event+track dedupe while one is
 * already waiting/delayed/active.
 */
export async function enqueueWebhookTrackRetry(
  data: WebhookTrackRetryJobData,
  opts: { delayMs?: number } = {}
): Promise<string> {
  const queue = getWebhookTrackRetryQueue()
  const job = await queue.add("webhook-track-retry", data, {
    jobId: `${data.webhookEventId}:${data.track}`,
    attempts: 1,
    ...(opts.delayMs !== undefined ? { delay: opts.delayMs } : {}),
  })
  return job.id!
}

/**
 * A scan's 1-based position in the run queue (and the total number waiting), so
 * the dashboard can tell the user how far from the front their scan is.
 *
 * Returns null when the scan is not currently waiting (already running, done,
 * or never enqueued) — the caller should only show a position for a QUEUED
 * scan. BullMQ returns waiting jobs oldest-first, so the index of this scan's
 * job in that list is its position. Read-only; never throws on a missing job.
 */
export interface ScanQueuePosition {
  /** 1-based place in line; 1 means it runs next. */
  position: number
  /** Total jobs currently waiting (including this one). */
  waiting: number
}

export async function getScanQueuePosition(scanId: string): Promise<ScanQueuePosition | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    const queue = getScanQueue()
    // v6 removed 'paused' from the JobType union; the scan queue is never
    // paused by the app, so only the active waiting states are queried.
    const waiting = await queue.getJobs(["wait", "delayed", "prioritized"])
    const index = waiting.findIndex((job) => job.id === scanId)
    if (index === -1) return null
    return { position: index + 1, waiting: waiting.length }
  } catch {
    return null
  }
}
