import { Queue, QueueEvents } from "bullmq"
import { env } from "@lyrashield/config"
import { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "@lyrashield/types"
import { getRedis } from "./redis"

const SCAN_WORKER_REGISTRY_KEY = "lyrashield:scan-workers"
export const SCAN_WORKER_HEARTBEAT_MS = 45_000
export const SCAN_WORKER_TTL_MS = 135_000

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
    return Number(results?.[1]?.[1] ?? 0) > 0
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

let scanQueueEvents: QueueEvents | null = null

export function getScanQueueEvents(): QueueEvents {
  if (!scanQueueEvents) {
    scanQueueEvents = new QueueEvents(SCAN_QUEUE_NAME, {
      connection: getConnectionOpts(),
    })
  }
  return scanQueueEvents
}

export async function enqueueScan(data: ScanJobData): Promise<string> {
  await assertScanWorkerAvailable()
  const queue = getScanQueue()
  const job = await queue.add("scan", data, { jobId: data.scanId })
  return job.id!
}
