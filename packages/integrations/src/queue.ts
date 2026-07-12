import { Queue, QueueEvents } from "bullmq"
import { env } from "@lyrashield/config"
import { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "@lyrashield/types"

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
  const queue = getScanQueue()
  const job = await queue.add("scan", data, { jobId: data.scanId })
  return job.id!
}
