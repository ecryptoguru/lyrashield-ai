/** Durable, generation-bound webhook retry execution and bounded queue recovery. */
import { getSystemPrisma, prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  WEBHOOK_TRACK_IDS,
  WEBHOOK_TRACK_MAX_ATTEMPTS,
  retryWebhookTrack,
  getWebhookTrackRetrySchedule,
  isExpiredWebhookTrackReplaySafe,
  normalizeProviderEvent,
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
  if (!schedule) return false
  await enqueueWebhookTrackRetry(
    { webhookEventId, track, generation: schedule.generation },
    { delayMs: schedule.delayMs }
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
  // The tracked subset is narrow by design. Pack credits/reversals have
  // transactionally idempotent provider identities; every other expired
  // handler remains receipt-review-only because it may have secondary effects.
  const expired = await prisma.$queryRaw<
    Array<{
      id: string
      webhookEventId: string
      track: string
      generation: number
      attempts: number
      claimToken: string | null
    }>
  >`
    SELECT id, "webhookEventId", track, generation, attempts, "claimToken"
    FROM "WebhookEventTrack"
    WHERE status = 'processing' AND "leaseExpiresAtUtc" <= now()
    ORDER BY "leaseExpiresAtUtc" ASC, id ASC
    LIMIT ${limit}
  `
  let ambiguous = 0
  let recoveredExpired = 0
  for (const row of expired) {
    const track = row.track as WebhookTrackId
    let replaySafe = false
    if (WEBHOOK_TRACK_IDS.includes(track)) {
      const stored = await getSystemPrisma().webhookEvent.findUnique({
        where: { id: row.webhookEventId },
        select: { provider: true, externalId: true, eventType: true, payload: true },
      })
      if (stored && (stored.provider === "polar" || stored.provider === "razorpay")) {
        try {
          const event = normalizeProviderEvent({
            provider: stored.provider,
            eventType: stored.eventType,
            payload: stored.payload,
            deliveryId: stored.externalId,
          })
          replaySafe =
            row.attempts < WEBHOOK_TRACK_MAX_ATTEMPTS &&
            isExpiredWebhookTrackReplaySafe(track, event)
        } catch {
          // Malformed historical receipts are never promoted to auto-replay.
        }
      }
    }
    if (replaySafe) {
      const changed = await prisma.$executeRaw`
        UPDATE "WebhookEventTrack"
        SET status = 'failed', "lastError" = 'claim_expired_replay_safe',
            generation = generation + 1, "nextAttemptAtUtc" = now(),
            "nextAttemptAt" = now() AT TIME ZONE current_setting('TimeZone'), "claimToken" = NULL,
            "leaseExpiresAtUtc" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
        WHERE id = ${row.id} AND "webhookEventId" = ${row.webhookEventId}
          AND track = ${row.track} AND generation = ${row.generation}
          AND "claimToken" IS NOT DISTINCT FROM ${row.claimToken}
          AND status = 'processing' AND "leaseExpiresAtUtc" <= now()
      `
      recoveredExpired += changed
    } else {
      const changed = await prisma.$executeRaw`
        UPDATE "WebhookEventTrack"
        SET status = 'dead_letter', "lastError" = 'claim_expired_requires_receipt_review',
            "claimToken" = NULL, "leaseExpiresAtUtc" = NULL, "leaseExpiresAt" = NULL,
            "nextAttemptAtUtc" = NULL, "nextAttemptAt" = NULL,
            "updatedAt" = now()
        WHERE id = ${row.id} AND "webhookEventId" = ${row.webhookEventId}
          AND track = ${row.track} AND generation = ${row.generation}
          AND "claimToken" IS NOT DISTINCT FROM ${row.claimToken}
          AND status = 'processing' AND "leaseExpiresAtUtc" <= now()
      `
      ambiguous += changed
    }
  }
  const due = await prisma.$queryRaw<
    Array<{ webhookEventId: string; track: string; generation: number }>
  >`
    SELECT "webhookEventId", track, generation
    FROM "WebhookEventTrack"
    WHERE status IN ('pending', 'failed') AND "nextAttemptAtUtc" <= now()
      AND "claimToken" IS NULL AND attempts < ${WEBHOOK_TRACK_MAX_ATTEMPTS}
    ORDER BY "nextAttemptAtUtc" ASC, id ASC
    LIMIT ${limit}
  `
  let represented = 0
  for (const row of due) {
    if (!WEBHOOK_TRACK_IDS.includes(row.track as WebhookTrackId)) continue
    try {
      let generation = row.generation
      const retained = await getWebhookTrackRetryQueue().getJob(webhookTrackRetryJobId(row))
      const state = await retained?.getState()
      if (state === "completed" || state === "failed") {
        const advanced = await prisma.$executeRaw`
          UPDATE "WebhookEventTrack" SET generation = generation + 1
          WHERE "webhookEventId" = ${row.webhookEventId} AND track = ${row.track}
            AND generation = ${generation} AND status IN ('pending', 'failed')
            AND "claimToken" IS NULL AND "nextAttemptAtUtc" <= now()
        `
        if (!advanced) continue
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
  if (recoveredExpired)
    logger.info("Expired idempotent webhook claims scheduled", { recoveredExpired })
  return { examined: due.length, represented, ambiguous }
}
