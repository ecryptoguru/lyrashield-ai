/** Durable, generation-bound webhook retry execution and bounded queue recovery. */
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  WEBHOOK_TRACK_IDS,
  WEBHOOK_TRACK_MAX_ATTEMPTS,
  retryWebhookTrack,
  getWebhookTrackRetrySchedule,
  type WebhookTrackHandlers,
  type WebhookTrackId,
} from "@lyrashield/billing"
import type { Job } from "bullmq"
import {
  enqueueWebhookTrackRetry,
  getWebhookTrackRetryQueue,
  webhookTrackRetryJobId,
  type WebhookTrackRetryJobData,
} from "@lyrashield/integrations"

export async function representWebhookTrackRetry(
  webhookEventId: string,
  track: WebhookTrackId
): Promise<boolean> {
  const schedule = await getWebhookTrackRetrySchedule(webhookEventId, track)
  if (!schedule?.nextAttemptAt) return false
  await enqueueWebhookTrackRetry(
    { webhookEventId, track, generation: schedule.generation },
    { delayMs: Math.max(0, schedule.nextAttemptAt.getTime() - Date.now()) }
  )
  return true
}

export async function processWebhookTrackRetry(
  job: Job<WebhookTrackRetryJobData>,
  handlers: WebhookTrackHandlers
): Promise<{ outcome: string; retryRepresented: boolean }> {
  const { webhookEventId, generation } = job.data
  const track = job.data.track as WebhookTrackId
  const legacy = generation === undefined
  if (
    !WEBHOOK_TRACK_IDS.includes(track) ||
    typeof webhookEventId !== "string" ||
    (!legacy &&
      (!Number.isSafeInteger(generation) ||
        generation < 0 ||
        job.id !== webhookTrackRetryJobId(job.data))) ||
    (legacy && job.id !== `${webhookEventId}:${track}`)
  ) {
    logger.error("Webhook track retry job identity rejected", { reason: "invalid_retry_identity" })
    return { outcome: "missing", retryRepresented: false }
  }
  const outcome = await retryWebhookTrack({ webhookEventId, track, generation, handlers })
  let retryRepresented = false
  if (outcome === "failed") {
    try {
      retryRepresented = await representWebhookTrackRetry(webhookEventId, track)
    } catch {
      logger.error("Webhook track retry enqueue failed", {
        webhookEventId,
        track,
        reason: "retry_enqueue_failed",
      })
    }
  }
  return { outcome, retryRepresented }
}

/** Existing maintenance timer calls this; no extra idle queue consumer. */
export async function recoverDueWebhookTrackRetries(
  limit = 100
): Promise<{ examined: number; represented: number; ambiguous: number }> {
  // A crashed claim may have completed an external effect. Stop for receipt review.
  // Bound both recovery writes and queue work, even after a long outage.
  const expired = await prisma.webhookEventTrack.findMany({
    where: { status: "processing", leaseExpiresAt: { lte: new Date() } },
    select: { id: true, claimToken: true },
    orderBy: { leaseExpiresAt: "asc" },
    take: limit,
  })
  let ambiguous = 0
  for (const row of expired) {
    const changed = await prisma.webhookEventTrack.updateMany({
      where: {
        id: row.id,
        status: "processing",
        claimToken: row.claimToken,
        leaseExpiresAt: { lte: new Date() },
      },
      data: {
        status: "dead_letter",
        lastError: "claim_expired_requires_receipt_review",
        claimToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      },
    })
    ambiguous += changed.count
  }
  const due = await prisma.webhookEventTrack.findMany({
    where: {
      status: { in: ["pending", "failed"] },
      nextAttemptAt: { lte: new Date() },
      claimToken: null,
      attempts: { lt: WEBHOOK_TRACK_MAX_ATTEMPTS },
    },
    select: { webhookEventId: true, track: true, generation: true, nextAttemptAt: true },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: limit,
  })
  let represented = 0
  for (const row of due) {
    if (!WEBHOOK_TRACK_IDS.includes(row.track as WebhookTrackId)) continue
    try {
      let generation = row.generation
      const retained = await getWebhookTrackRetryQueue().getJob(webhookTrackRetryJobId(row))
      const state = await retained?.getState()
      if (state === "completed" || state === "failed") {
        const advanced = await prisma.webhookEventTrack.updateMany({
          where: {
            webhookEventId: row.webhookEventId,
            track: row.track,
            generation,
            status: { in: ["pending", "failed"] },
            claimToken: null,
            nextAttemptAt: { lte: new Date() },
          },
          data: { generation: { increment: 1 } },
        })
        if (!advanced.count) continue
        generation++
      }
      await enqueueWebhookTrackRetry({
        webhookEventId: row.webhookEventId,
        track: row.track,
        generation,
      })
      represented++
    } catch {
      logger.error("Webhook due retry enqueue failed", { reason: "retry_enqueue_failed" })
    }
  }
  if (ambiguous) logger.warn("Webhook claims require receipt review", { ambiguous })
  return { examined: due.length, represented, ambiguous }
}
