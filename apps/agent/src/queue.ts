import { Queue } from "bullmq"
import { env } from "@lyrashield/config"
import { SCAN_QUEUE_NAME, type ScanJobData } from "@lyrashield/types"

let queue: Queue | null = null

function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(SCAN_QUEUE_NAME, {
      connection: {
        url: env.REDIS_URL || "redis://localhost:6379",
        maxRetriesPerRequest: null,
      },
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
  return queue
}

export async function enqueueScanJob(data: ScanJobData): Promise<string> {
  const q = getQueue()
  const job = await q.add("scan", data, {
    jobId: data.scanId,
  })
  return job.id!
}
