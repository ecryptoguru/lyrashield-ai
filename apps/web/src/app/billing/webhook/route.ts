import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  validatePolarWebhook,
  validateRazorpayWebhook,
  resolveRazorpayEventIdentity,
  normalizeProviderEvent,
  assertProviderCatalogEvent,
  runApplicableTracks,
  WebhookAuthError,
  WebhookPayloadError,
} from "@lyrashield/billing"
import { dispatch as dispatchAffiliate } from "@lyrashield/affiliate"
import { enqueueWebhookTrackRetry } from "@lyrashield/integrations"
import { createHash } from "node:crypto"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Billing webhook handler — accepts both Polar and Razorpay webhooks.
 *
 * The provider is determined by the presence of Polar-specific headers
 * (`webhook-id`, with legacy `webhooks-id` accepted) vs Razorpay-specific
 * headers (X-Razorpay-Signature).
 *
 * Event identity (dedupe key = @@unique([provider, externalId])):
 * - Polar: the Standard Webhooks delivery id (`webhook-id`) — distinct per
 *   delivery, so lifecycle events on one subscription never collide.
 * - Razorpay: `X-Razorpay-Event-ID` header when present; otherwise a stable
 *   sha256 digest of `event|primaryResourceId|created_at`. Never random —
 *   the same logical redelivery must always resolve to the same identity.
 *
 * Flow (synchronous, like the GitHub webhook):
 * 1. Validate signature (401/400 on auth/payload failures — see below)
 * 2. Insert WebhookEvent FIRST — the DB unique constraint is the concurrency
 *    arbiter: of simultaneous duplicate deliveries exactly one inserts and
 *    processes; losers answer 200 without side effects.
 * 3. Process the event synchronously BEFORE responding via durable required
 *    tracks (findings 12 / 18A) — one WebhookEventTrack row per applicable
 *    track, executed through the shared executor:
 *    a. billing:   entitlements / pack credit / refund reversal adapters
 *    b. license:   Local SKU purchase fulfillment (both providers)
 *    c. affiliate: commission/clawback via normalized domain events
 *    A failed track marks its row "failed", enqueues a durable BullMQ retry,
 *    and answers 5xx so the provider also redelivers. The parent `processed`
 *    flag is DERIVED: true only when every applicable track succeeded.
 * 4. Respond 200 only when every applicable track row is "succeeded".
 *
 * Single webhook ingress — Track C never registers a second webhook route.
 * Both tracks consume the same idempotent WebhookEvent rows.
 */

/**
 * ponytail: in-flight window heuristic — an unprocessed row younger than this
 * is assumed to belong to a concurrent delivery (skip + 200); older unprocessed
 * rows are crash/failure strays and are reprocessed. If providers ever overlap
 * >60s processing runs, replace with a lease column (commit-3 territory).
 */
const REPROCESS_MIN_AGE_MS = 60_000

/** Response class map for validation-phase failures. */
function authErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof WebhookAuthError) {
    // Auth-layer rejection: missing/invalid signature or anti-replay failure.
    // Non-retryable — retrying identical garbage can never succeed. 401 for
    // signature problems; stale timestamps and misconfig keep 400/500 below.
    const status =
      error.reason === "missing_signature" || error.reason === "invalid_signature"
        ? 401
        : error.reason === "stale_timestamp"
          ? 400
          : 500
    return NextResponse.json(
      {
        success: false,
        error: { code: "WEBHOOK_UNAUTHORIZED", message: "Webhook authentication failed" },
      },
      { status }
    )
  }
  if (error instanceof WebhookPayloadError) {
    // Signature was valid but the body is unusable — non-retryable.
    return NextResponse.json(
      {
        success: false,
        error: { code: "WEBHOOK_MALFORMED_PAYLOAD", message: "Webhook payload rejected" },
      },
      { status: 400 }
    )
  }
  return null
}

/**
 * Deterministic fallback identity when a provider omits its delivery id.
 * sha256 over provider-scoped event facts — same inputs, same id, forever.
 */
function deriveIdentity(parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex")
}

export async function POST(request: Request) {
  const body = await request.text()
  const headers: Record<string, string | string[] | undefined> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  // Detect provider by headers
  const hasPolarHeaders =
    headers["webhook-id"] !== undefined || headers["webhooks-id"] !== undefined
  const hasRazorpayHeaders = headers["x-razorpay-signature"] !== undefined

  if (!hasPolarHeaders && !hasRazorpayHeaders) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "UNKNOWN_PROVIDER", message: "Unrecognized webhook provider" },
      },
      { status: 400 }
    )
  }

  let provider: "polar" | "razorpay"
  let externalId: string
  let identitySource: "delivery" | "derived"
  let eventType: string
  let payload: unknown

  // ── Phase 1: signature + payload validation (response-classified) ────────
  try {
    if (hasPolarHeaders) {
      provider = "polar"
      const event = validatePolarWebhook(body, headers)
      const deliveryId =
        (headers["webhook-id"] as string) ?? (headers["webhooks-id"] as string) ?? ""
      if (deliveryId) {
        externalId = deliveryId
        identitySource = "delivery"
      } else {
        // Validator enforces webhook-id presence, so this is defense-in-depth:
        // deterministic digest instead of a random id that would break dedupe.
        externalId = deriveIdentity([
          event.type,
          String(event.data?.id ?? ""),
          String(headers["webhook-timestamp"] ?? ""),
        ])
        identitySource = "derived"
      }
      eventType = event.type
      payload = event
    } else {
      provider = "razorpay"
      const signature = (headers["x-razorpay-signature"] as string) ?? ""
      const event = validateRazorpayWebhook(body, signature)
      const identity = resolveRazorpayEventIdentity(
        event,
        headers["x-razorpay-event-id"] as string | undefined
      )
      if (!identity) {
        throw new WebhookPayloadError("Razorpay webhook carries no primary resource id")
      }
      externalId = identity.externalId
      identitySource = identity.identitySource
      eventType = event.event
      payload = event
    }
    assertProviderCatalogEvent(provider, eventType, payload)
  } catch (error) {
    const classified = authErrorResponse(error)
    if (classified) {
      logger.warn("Webhook validation rejected", {
        provider: hasPolarHeaders ? "polar" : "razorpay",
        reason:
          error instanceof WebhookAuthError
            ? error.reason
            : error instanceof WebhookPayloadError
              ? "malformed_payload"
              : "validation_failed",
      })
      return classified
    }
    logger.error("Webhook validation failed unexpectedly", {
      provider: hasPolarHeaders ? "polar" : "razorpay",
      reason: "processing_failed",
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      {
        success: false,
        error: { code: "WEBHOOK_PROCESSING_FAILED", message: "Webhook processing error" },
      },
      { status: 500 }
    )
  }

  const normalized = normalizeProviderEvent({
    provider,
    eventType,
    payload,
    deliveryId: externalId,
  })

  // ── Phase 2: claim via unique constraint (concurrency arbiter) ────────────
  let claimedEventId: string | null = null
  try {
    const inserted = await insertWebhookEvent(
      provider,
      externalId,
      identitySource,
      eventType,
      payload,
      normalized.workspaceId
    )
    if (!inserted) {
      const existingEvent = await prisma.webhookEvent.findUnique({
        where: { provider_externalId: { provider, externalId } },
        select: { id: true, workspaceId: true, processed: true, createdAt: true },
      })
      if (!existingEvent) {
        // Row vanished between the P2002 and this lookup (practically
        // unreachable) — treat as a fresh claim and process below.
        logger.info("Webhook event row vanished after duplicate insert", {
          provider,
          eventType,
          externalId,
        })
      } else if (existingEvent.processed) {
        if (!existingEvent.workspaceId && normalized.workspaceId) {
          await prisma.webhookEvent.updateMany({
            where: { id: existingEvent.id, workspaceId: null },
            data: { workspaceId: normalized.workspaceId },
          })
        }
        // Exact replay of an already-processed event — acknowledge immediately.
        // Zero extra side effects: every applicable track is already succeeded.
        logger.info("Webhook replay acknowledged", { provider, eventType, externalId })
        return NextResponse.json({ success: true }, { status: 200 })
      } else if (Date.now() - existingEvent.createdAt.getTime() < REPROCESS_MIN_AGE_MS) {
        logger.info("Concurrent duplicate delivery skipped", { provider, eventType, externalId })
        return NextResponse.json({ success: true }, { status: 200 })
      } else {
        logger.info("Reprocessing stranded webhook event", { provider, eventType, externalId })
        claimedEventId = existingEvent.id
      }
    } else {
      claimedEventId = inserted.id
    }

    if (!claimedEventId) {
      // Unreachable in practice (row vanished between P2002 and lookup);
      // fail closed with 5xx so the provider redelivers instead of running
      // required tracks without durable state.
      logger.error("Webhook event claim lost after arbiter", {
        provider,
        eventType,
        externalId,
        reason: "claim_lost",
      })
      return NextResponse.json(
        {
          success: false,
          error: { code: "WEBHOOK_PROCESSING_FAILED", message: "Webhook processing error" },
        },
        { status: 500 }
      )
    }

    // ── Phase 3: durable required tracks (billing/license/affiliate) ─────────
    const summary = await runApplicableTracks({
      webhookEventId: claimedEventId,
      event: normalized,
      rawPayload: payload,
      handlers: { dispatchAffiliate },
    })

    if (!summary.allSucceeded) {
      // Durably queue one bounded retry per failed track (dead-lettered tracks
      // are terminal and are NOT re-enqueued). An enqueue failure is logged
      // with a reason code — the answer is 5xx either way, so the provider
      // redelivery remains the additional recovery path.
      for (const failure of summary.failures) {
        try {
          await enqueueWebhookTrackRetry({
            webhookEventId: claimedEventId,
            track: failure.track,
          })
        } catch (enqueueError) {
          logger.error("Webhook track retry enqueue failed", {
            webhookEventId: claimedEventId,
            track: failure.track,
            reason: "retry_enqueue_failed",
            error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
          })
        }
      }
      logger.warn("Webhook answered 5xx — required track(s) not satisfied", {
        provider,
        eventType,
        externalId,
        webhookEventId: claimedEventId,
        failedTracks: summary.failures.map((f) => f.track),
        deadLetteredTracks: summary.deadLettered.map((f) => f.track),
        reason: "required_track_failed",
      })
      return NextResponse.json(
        {
          success: false,
          error: { code: "WEBHOOK_PROCESSING_FAILED", message: "Webhook processing error" },
        },
        { status: 500 }
      )
    }
  } catch (error) {
    // Transient processing failure — answer 5xx so the provider retries.
    // The unprocessed row (and any pending/failed track rows) remain; the
    // durable retry queue plus provider redelivery recover them.
    logger.error("Webhook processing failed", {
      provider,
      eventType,
      externalId,
      reason: "processing_failed",
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      {
        success: false,
        error: { code: "WEBHOOK_PROCESSING_FAILED", message: "Webhook processing error" },
      },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true }, { status: 200 })
}

/**
 * Insert a WebhookEvent row, idempotent on (provider, externalId).
 * The DB unique constraint arbitrates concurrent duplicates: exactly one
 * caller inserts. Returns null to signal a duplicate/replay.
 */
async function insertWebhookEvent(
  provider: string,
  externalId: string,
  identitySource: "delivery" | "derived",
  eventType: string,
  payload: unknown,
  workspaceId: string | null
): Promise<{ id: string } | null> {
  try {
    const created = await prisma.webhookEvent.create({
      data: {
        provider,
        externalId,
        eventType,
        payload: payload as Record<string, unknown>,
        workspaceId,
        processed: false,
        identitySource,
      },
      select: { id: true },
    })
    return created
  } catch (error) {
    // P2002 = unique constraint — duplicate delivery, arbiter says we lost
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      logger.debug("Webhook event duplicate (constraint arbiter)", { provider, externalId })
      return null
    }
    throw error
  }
}
