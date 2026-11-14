import { Worker } from "bullmq"
import { env } from "@lyrashield/config"
import { logger } from "@lyrashield/logger"
import { dispatch as dispatchAffiliate } from "@lyrashield/affiliate"
import {
  WEBHOOK_TRACK_RETRY_QUEUE_NAME,
  type WebhookTrackRetryJobData,
} from "@lyrashield/integrations"
import { processWebhookTrackRetry } from "./jobs/webhook-track-retry.job"
import { WEBHOOK_TRACK_RETRY_WORKER_CONCURRENCY } from "./worker-lifecycle"

export async function startWebhookTrackRetryWorker(
  drainDelay: number,
  stalledInterval: number,
  recordWorker: (worker: Worker<WebhookTrackRetryJobData, void>) => void
) {
  // Webhook required-track retries (findings 12 / 18A). Separate BullMQ queue
  // + worker sharing the same connection options; the processor delegates to
  // the shared executor in @lyrashield/billing via injected handlers.
  const webhookTrackRetryWorker = new Worker<WebhookTrackRetryJobData, void>(
    WEBHOOK_TRACK_RETRY_QUEUE_NAME,
    async (job) => {
      const result = await processWebhookTrackRetry(job, { dispatchAffiliate })
      logger.info("Webhook track retry processed", {
        jobId: job.id,
        webhookEventId: job.data.webhookEventId,
        track: job.data.track,
        outcome: result.outcome,
        retryRepresented: result.retryRepresented,
      })
    },
    {
      connection: {
        url: env.REDIS_URL || "redis://localhost:6379",
        maxRetriesPerRequest: null,
      },
      concurrency: WEBHOOK_TRACK_RETRY_WORKER_CONCURRENCY,
      autorun: false,
      // Keep instant job pickup while avoiding BullMQ's five-second idle poll,
      // which alone exceeds a 500,000-command monthly managed Redis budget.
      drainDelay,
      stalledInterval,
    }
  )
  recordWorker(webhookTrackRetryWorker)
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

  return webhookTrackRetryWorker
}
