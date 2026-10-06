import {
  isExpiredWebhookTrackReplaySafe,
  normalizeProviderEvent,
  WEBHOOK_TRACK_IDS,
} from "@lyrashield/billing"
import { executePlatformAdminMutation } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import { apiError, apiSuccess } from "@/lib/api-response"
import { authErrorResponse } from "@/lib/api-auth"
import { z } from "zod"

export const ACTION = "billing.webhook-track.disposition"
export const MAX_EXPECTED_GENERATION = 2_147_483_646
export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
}

const EVIDENCE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,127}$/

export const dispositionSchema = z
  .object({
    expectedGeneration: z.number().int().min(0).max(MAX_EXPECTED_GENERATION),
    reason: z.enum(["effect_confirmed", "no_effect_required"]),
    evidenceReference: z.string().regex(EVIDENCE_REFERENCE),
  })
  .strict()

type ProviderReceipt = {
  provider: "polar" | "razorpay"
  externalId: string
  eventType: string
  payload: unknown
}

function isReplaySafeTrack(trackId: string, event: ProviderReceipt): boolean {
  try {
    return isExpiredWebhookTrackReplaySafe(
      trackId as (typeof WEBHOOK_TRACK_IDS)[number],
      normalizeProviderEvent({
        provider: event.provider,
        eventType: event.eventType,
        payload: event.payload,
        deliveryId: event.externalId,
      })
    )
  } catch {
    // Malformed historical receipts still require explicit evidence and an
    // operator disposition; they are never promoted to replay-safe.
    return false
  }
}

function dispositionFailureResponse(error: unknown): Response {
  if (error instanceof Error && error.message === "WEBHOOK_TRACK_NOT_FOUND") {
    return apiError("WEBHOOK_TRACK_NOT_FOUND", "Webhook track not found", 404, PRIVATE_HEADERS)
  }
  if (error instanceof Error && error.message === "WEBHOOK_TRACK_DISPOSITION_NOT_ALLOWED") {
    return apiError(
      "WEBHOOK_TRACK_DISPOSITION_NOT_ALLOWED",
      "This track is active, stale, replay-safe, or already resolved",
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
  if (authError) {
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) authError.headers.set(name, value)
    return authError
  }
  logger.error("Platform administrator webhook disposition failed", {
    reason: "webhook_track_disposition_transaction_failed",
  })
  return apiError("INTERNAL_ERROR", "Could not authorize webhook disposition", 500, PRIVATE_HEADERS)
}

export async function disposeWebhookTrack({
  id,
  admin,
  nonce,
  expectedGeneration,
  reason,
  evidenceReference,
  ipAddress,
  userAgent,
}: {
  id: string
  admin: { userId: string; sessionId: string }
  nonce: string
  expectedGeneration: number
  reason: "effect_confirmed" | "no_effect_required"
  evidenceReference: string
  ipAddress: string | undefined
  userAgent: string | undefined
}): Promise<Response> {
  let disposition: { webhookEventId: string; generation: number; processed: boolean }
  try {
    disposition = await executePlatformAdminMutation(
      {
        userId: admin.userId,
        sessionId: admin.sessionId,
        action: ACTION,
        nonce,
        resourceType: "WebhookEventTrack",
        resourceId: id,
        ipAddress,
        userAgent,
        metadata: { expectedGeneration, reason, evidenceReference },
      },
      async (tx) => {
        const track = await tx.webhookEventTrack.findUnique({
          where: { id },
          select: {
            id: true,
            webhookEventId: true,
            track: true,
            status: true,
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
        if (
          !WEBHOOK_TRACK_IDS.includes(track.track as (typeof WEBHOOK_TRACK_IDS)[number]) ||
          track.generation !== expectedGeneration ||
          (track.status !== "dead_letter" && !historicalUnscheduled) ||
          track.claimToken !== null ||
          track.leaseExpiresAt !== null ||
          track.leaseExpiresAtUtc !== null
        ) {
          throw new Error("WEBHOOK_TRACK_DISPOSITION_NOT_ALLOWED")
        }

        const event = await tx.webhookEvent.findUnique({
          where: { id: track.webhookEventId },
          select: {
            id: true,
            provider: true,
            externalId: true,
            eventType: true,
            payload: true,
            processed: true,
            deletedAt: true,
          },
        })
        if (
          !event ||
          event.deletedAt !== null ||
          (event.provider !== "polar" && event.provider !== "razorpay")
        ) {
          throw new Error("WEBHOOK_TRACK_DISPOSITION_NOT_ALLOWED")
        }

        if (
          isReplaySafeTrack(track.track, {
            provider: event.provider,
            externalId: event.externalId,
            eventType: event.eventType,
            payload: event.payload,
          })
        ) {
          throw new Error("WEBHOOK_TRACK_DISPOSITION_NOT_ALLOWED")
        }

        const changed = await tx.$executeRaw`
          UPDATE "WebhookEventTrack"
          SET status = 'reviewed', "lastError" = 'operator_reviewed_without_replay',
              generation = generation + 1, completedAt = now(),
              "nextAttemptAtUtc" = NULL, "nextAttemptAt" = NULL,
              "claimToken" = NULL, "leaseExpiresAtUtc" = NULL, "leaseExpiresAt" = NULL,
              "updatedAt" = now()
          WHERE id = ${track.id} AND "webhookEventId" = ${track.webhookEventId}
            AND track = ${track.track} AND status = ${track.status}
            AND generation = ${expectedGeneration}
            AND "claimToken" IS NULL AND "leaseExpiresAt" IS NULL
            AND "leaseExpiresAtUtc" IS NULL
            AND (
              status = 'dead_letter' OR
              (status IN ('pending', 'failed', 'processing') AND "nextAttemptAt" IS NULL AND "nextAttemptAtUtc" IS NULL)
            )
        `
        if (changed !== 1) throw new Error("WEBHOOK_TRACK_DISPOSITION_NOT_ALLOWED")

        const [total, unresolved] = await Promise.all([
          tx.webhookEventTrack.count({ where: { webhookEventId: track.webhookEventId } }),
          tx.webhookEventTrack.count({
            where: {
              webhookEventId: track.webhookEventId,
              status: { notIn: ["succeeded", "reviewed"] },
            },
          }),
        ])
        const processed = event.processed || (total > 0 && unresolved === 0)
        if (!event.processed && processed) {
          await tx.$executeRaw`
            UPDATE "WebhookEvent" SET processed = true, "processedAt" = now()
            WHERE id = ${track.webhookEventId} AND processed = false AND "deletedAt" IS NULL
          `
        }

        return {
          webhookEventId: track.webhookEventId,
          generation: expectedGeneration + 1,
          processed,
        }
      }
    )
  } catch (error) {
    return dispositionFailureResponse(error)
  }

  const response = apiSuccess({
    status: "reviewed",
    generation: disposition.generation,
    processed: disposition.processed,
  })
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value)
  return response
}
