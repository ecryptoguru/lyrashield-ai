/**
 * Webhook required-track retry job (findings 12 / 18A).
 *
 * Consumes the `webhook-track-retry` BullMQ queue (queue authority:
 * @lyrashield/integrations — same connection factory as the scan queue). Each
 * job re-executes exactly ONE failed track of a stored WebhookEvent through
 * the shared executor in @lyrashield/billing, updates durable track state,
 * and re-enqueues one delayed next attempt while under the bounded attempt
 * budget. Dead-lettered tracks are terminal — never re-enqueued.
 */

import { logger } from "@lyrashield/logger"
import {
  WEBHOOK_TRACK_IDS,
  WEBHOOK_TRACK_MAX_ATTEMPTS,
  retryWebhookTrack,
  type WebhookTrackHandlers,
  type WebhookTrackId,
} from "@lyrashield/billing"
import type { Job } from "bullmq"
import { enqueueWebhookTrackRetry, type WebhookTrackRetryJobData } from "@lyrashield/integrations"

/** Fixed delay before the next attempt; the DB row owns the attempt budget. */
export const WEBHOOK_TRACK_RETRY_DELAY_MS = 60_000

export interface WebhookTrackRetryResult {
  outcome: string
  reEnqueued: boolean
}

/**
 * Process one webhook-track retry job.
 *
 * Handlers injected here keep this worker module free of cross-package wiring:
 * affiliate dispatch is passed straight through to the shared executor.
 */
export async function processWebhookTrackRetry(
  job: Job<WebhookTrackRetryJobData>,
  handlers: WebhookTrackHandlers
): Promise<WebhookTrackRetryResult> {
  const { webhookEventId } = job.data
  const track = job.data.track as WebhookTrackId

  if (!WEBHOOK_TRACK_IDS.includes(track)) {
    // Malformed job data — not retryable; log and drop (BullMQ attempts: 1).
    logger.error("Webhook track retry job has unknown track", { webhookEventId, track })
    return { outcome: "missing", reEnqueued: false }
  }

  const outcome = await retryWebhookTrack({ webhookEventId, track, handlers })

  let reEnqueued = false
  if (outcome === "failed") {
    // Under the cap (attempt < WEBHOOK_TRACK_MAX_ATTEMPTS) — schedule exactly
    // one bounded next attempt. Dead-letter outcomes are never re-enqueued.
    try {
      await enqueueWebhookTrackRetry(
        { webhookEventId, track },
        { delayMs: WEBHOOK_TRACK_RETRY_DELAY_MS }
      )
      reEnqueued = true
    } catch (error) {
      logger.error("Webhook track retry re-enqueue failed", {
        webhookEventId,
        track,
        reason: "retry_enqueue_failed",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { outcome, reEnqueued }
}

export { WEBHOOK_TRACK_MAX_ATTEMPTS }
