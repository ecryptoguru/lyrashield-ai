import { Queue } from "bullmq"
import { env } from "@lyrashield/config"
import { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "@lyrashield/types"
import { getRedis } from "./redis"

const SCAN_WORKER_REGISTRY_KEY = "lyrashield:scan-workers"
export const SCAN_WORKER_HEARTBEAT_MS = 120_000
export const SCAN_WORKER_TTL_MS = 300_000

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

export async function registerScanWorker(workerId: string, now = Date.now()): Promise<void> {
  const redis = requireRedis()
  await redis
    .multi()
    .zremrangebyscore(SCAN_WORKER_REGISTRY_KEY, "-inf", now)
    .zadd(SCAN_WORKER_REGISTRY_KEY, now + SCAN_WORKER_TTL_MS, workerId)
    .pexpire(SCAN_WORKER_REGISTRY_KEY, SCAN_WORKER_TTL_MS * 2)
    .exec()
}

export async function unregisterScanWorker(workerId: string): Promise<void> {
  const redis = getRedis()
  if (redis) await redis.zrem(SCAN_WORKER_REGISTRY_KEY, workerId)
}

export async function isScanWorkerAvailable(now = Date.now()): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return false

  try {
    const results = await redis
      .multi()
      .zremrangebyscore(SCAN_WORKER_REGISTRY_KEY, "-inf", now)
      .zcard(SCAN_WORKER_REGISTRY_KEY)
      .exec()
    if (Number(results?.[1]?.[1] ?? 0) === 0) return false

    // A heartbeat alone only proves that a process reached Redis. Require an
    // actual BullMQ consumer on this queue before admitting a billable scan.
    return (await getScanQueue().getWorkersCount()) > 0
  } catch {
    return false
  }
}

export async function assertScanWorkerAvailable(): Promise<void> {
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
