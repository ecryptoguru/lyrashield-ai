import { Queue, QueueEvents } from "bullmq"
import { env } from "@lyrashield/config"
import { SCAN_QUEUE_NAME, type ScanJobData, type ScanJobResult } from "./types"

export { SCAN_QUEUE_NAME }
export type { ScanJobData, ScanJobResult }

function getConnectionOpts() {
  return {
    url: env.REDIS_URL || "redis://localhost:6379",
    maxRetriesPerRequest: null as number | null,
  }
}

export function getScanQueue(): Queue {
  return new Queue(SCAN_QUEUE_NAME, {
    connection: getConnectionOpts(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  })
}

export function getScanQueueEvents(): QueueEvents {
  return new QueueEvents(SCAN_QUEUE_NAME, {
    connection: getConnectionOpts(),
  })
}

export async function enqueueScan(data: ScanJobData): Promise<string> {
  const queue = getScanQueue()
  const job = await queue.add("scan", data, {
    jobId: data.scanId,
  })
  await queue.close()
  return job.id!
}
