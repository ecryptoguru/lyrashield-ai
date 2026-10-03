import {
  isExpiredWebhookTrackReplaySafe,
  normalizeProviderEvent,
  WEBHOOK_TRACK_MAX_ATTEMPTS,
} from "@lyrashield/billing"
import { executePlatformAdminMutation } from "@lyrashield/db"
import { enqueueWebhookTrackRetry } from "@lyrashield/integrations"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"
import { z } from "zod"

export const ACTION = "billing.webhook-track.retry"
export const MAX_EXPECTED_GENERATION = 2_147_483_646
export const MAX_OPERATOR_RECOVERIES = 3
export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
}

export const retrySchema = z
  .object({
    expectedGeneration: z.number().int().min(0).max(MAX_EXPECTED_GENERATION),
    reason: z.enum(["provider_receipt_reviewed", "transient_failure_corrected"]),
  })
  .strict()

export function privateResponse(response: Response): Response {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value)
  return response
}

function retryFailureResponse(error: unknown): Response {
  if (error instanceof Error && error.message === "WEBHOOK_TRACK_NOT_FOUND") {
    return apiError("WEBHOOK_TRACK_NOT_FOUND", "Webhook track not found", 404, PRIVATE_HEADERS)
  }
  if (error instanceof Error && error.message === "WEBHOOK_TRACK_RETRY_NOT_ALLOWED") {
    return apiError(
      "WEBHOOK_TRACK_RETRY_NOT_ALLOWED",
      "This webhook track is stale, exhausted, or not eligible for automatic replay",
      409,
      PRIVATE_HEADERS
    )
  }
  if (error instanceof Error && error.message === "ADMIN_ELEVATION_INVALID") {
    return apiError(
      "ADMIN_ELEVATION_INVALID",
      "That elevation expired or was already used — authorize the action again",
      409,
      PRIVATE_HEADERS
    )
  }
  const authError = authErrorResponse(error)
  if (authError) return privateResponse(authError)
  logger.error("Platform administrator webhook retry failed", {
    reason: "webhook_track_retry_transaction_failed",
  })
  return apiError("INTERNAL_ERROR", "Could not authorize webhook retry", 500, PRIVATE_HEADERS)
}

async function enqueueScheduledRetry(scheduled: {
  webhookEventId: string
  generation: number
}): Promise<boolean> {
  try {
    await enqueueWebhookTrackRetry({
      webhookEventId: scheduled.webhookEventId,
      track: "billing",
      generation: scheduled.generation,
    })
    return true
  } catch {
    logger.error("Platform administrator webhook retry enqueue failed", {
      reason: "webhook_track_retry_enqueue_failed",
    })
    return false
  }
}

export async function scheduleWebhookTrackRetry({
  id,
  admin,
  nonce,
  expectedGeneration,
  reason,
  ipAddress,
  userAgent,
}: {
  id: string
  admin: { userId: string; sessionId: string }
  nonce: string
  expectedGeneration: number
  reason: "provider_receipt_reviewed" | "transient_failure_corrected"
  ipAddress: string | undefined
  userAgent: string | undefined
}): Promise<Response> {
  let scheduled: { webhookEventId: string; generation: number }
  try {
    scheduled = await executePlatformAdminMutation(
      {
        userId: admin.userId,
        sessionId: admin.sessionId,
        action: ACTION,
        nonce,
        resourceType: "WebhookEventTrack",
        resourceId: id,
        ipAddress,
        userAgent,
        metadata: { reason, expectedGeneration },
      },
      async (tx) => {
        const track = await tx.webhookEventTrack.findUnique({
          where: { id },
          select: {
            id: true,
            webhookEventId: true,
            track: true,
            status: true,
            attempts: true,
            operatorRecoveryCount: true,
            generation: true,
            claimToken: true,
            leaseExpiresAt: true,
            leaseExpiresAtUtc: true,
            nextAttemptAt: true,
            nextAttemptAtUtc: true,
          },
        })
        if (!track) throw new Error("WEBHOOK_TRACK_NOT_FOUND")
        const historicalUnscheduled =
          (track.status === "pending" ||
            track.status === "failed" ||
            track.status === "processing") &&
          track.nextAttemptAt === null &&
          track.nextAttemptAtUtc === null
        const recoverableStatus = track.status === "dead_letter" || historicalUnscheduled
        if (
          track.track !== "billing" ||
          !recoverableStatus ||
          track.generation !== expectedGeneration ||
          track.attempts > WEBHOOK_TRACK_MAX_ATTEMPTS ||
          (track.status === "dead_letter" && track.attempts < 1) ||
          track.operatorRecoveryCount >= MAX_OPERATOR_RECOVERIES ||
          track.claimToken !== null ||
          track.leaseExpiresAt !== null ||
          track.leaseExpiresAtUtc !== null
        ) {
          throw new Error("WEBHOOK_TRACK_RETRY_NOT_ALLOWED")
        }

        const event = await tx.webhookEvent.findUnique({
          where: { id: track.webhookEventId },
          select: {
            provider: true,
            externalId: true,
            eventType: true,
            payload: true,
            deletedAt: true,
          },
        })
        if (
          !event ||
          event.deletedAt !== null ||
          (event.provider !== "polar" && event.provider !== "razorpay")
        ) {
          throw new Error("WEBHOOK_TRACK_RETRY_NOT_ALLOWED")
        }

        let replaySafe = false
        try {
          replaySafe = isExpiredWebhookTrackReplaySafe(
            "billing",
            normalizeProviderEvent({
              provider: event.provider,
              eventType: event.eventType,
              payload: event.payload,
              deliveryId: event.externalId,
            })
          )
        } catch {
          // Historical malformed receipts are never promoted to replayable.
        }
        if (!replaySafe) throw new Error("WEBHOOK_TRACK_RETRY_NOT_ALLOWED")

        const changed = await tx.$executeRaw`
          UPDATE "WebhookEventTrack"
          SET status = 'failed', "lastError" = 'operator_retry_authorized',
              generation = generation + 1, "historicalAttempts" = "historicalAttempts" + attempts,
              attempts = 0, "operatorRecoveryCount" = "operatorRecoveryCount" + 1,
              "nextAttemptAtUtc" = now(),
              "nextAttemptAt" = now() AT TIME ZONE current_setting('TimeZone'),
              "claimToken" = NULL, "leaseExpiresAtUtc" = NULL, "leaseExpiresAt" = NULL,
              "updatedAt" = now()
          WHERE id = ${track.id} AND "webhookEventId" = ${track.webhookEventId}
            AND track = 'billing' AND status = ${track.status}
            AND generation = ${expectedGeneration}
            AND attempts = ${track.attempts}
            AND "operatorRecoveryCount" = ${track.operatorRecoveryCount}
            AND "operatorRecoveryCount" < ${MAX_OPERATOR_RECOVERIES}
            AND "claimToken" IS NULL AND "leaseExpiresAt" IS NULL
            AND "leaseExpiresAtUtc" IS NULL
            AND (
              status = 'dead_letter' OR
              (status IN ('pending', 'failed', 'processing') AND "nextAttemptAt" IS NULL AND "nextAttemptAtUtc" IS NULL)
            )
        `
        if (changed !== 1) throw new Error("WEBHOOK_TRACK_RETRY_NOT_ALLOWED")

        return { webhookEventId: track.webhookEventId, generation: expectedGeneration + 1 }
      }
    )
  } catch (error) {
    return retryFailureResponse(error)
  }

  const queued = await enqueueScheduledRetry(scheduled)
  return privateResponse(
    apiSuccess({ status: "scheduled", queued, generation: scheduled.generation }, 202)
  )
}
