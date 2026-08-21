import { NextResponse } from "next/server"
import { prisma } from "@lyrashield/db"
import { logger } from "@lyrashield/logger"
import {
  validatePolarWebhook,
  validateRazorpayWebhook,
  processPolarEvent,
  processRazorpayEvent,
  isHandledPolarEvent,
  isHandledRazorpayEvent,
  resolveRazorpayEventIdentity,
  resolveProviderKey,
  WebhookAuthError,
  WebhookPayloadError,
} from "@lyrashield/billing"
import { dispatch as dispatchAffiliate } from "@lyrashield/affiliate"
import { env } from "@lyrashield/config"
import { createHash } from "node:crypto"
import { LOCAL_SKU_MAP, type LocalSkuId } from "@lyrashield/pricing"
import { issueLicenseForPolarOrder } from "@/lib/licenses/license-service"

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
 * 3. Process the event synchronously BEFORE responding:
 *    a. Track A: syncSubscription / creditTopUp (billing entitlements)
 *    b. Track B: issue license for Local SKU Polar one-time orders
 *    c. Track C: affiliate commission/clawback via webhook-dispatch
 * 4. Update WebhookEvent: processed=true, processedAt=now()
 * 5. Respond 200
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

  // ── Phase 2: claim via unique constraint (concurrency arbiter) ────────────
  try {
    const inserted = await insertWebhookEvent(
      provider,
      externalId,
      identitySource,
      eventType,
      payload
    )
    if (!inserted) {
      const existingEvent = await prisma.webhookEvent.findUnique({
        where: { provider_externalId: { provider, externalId } },
        select: { processed: true, createdAt: true },
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
        // Exact replay of an already-processed event — acknowledge immediately.
        logger.info("Webhook replay acknowledged", { provider, eventType, externalId })
        return NextResponse.json({ success: true }, { status: 200 })
      } else if (Date.now() - existingEvent.createdAt.getTime() < REPROCESS_MIN_AGE_MS) {
        logger.info("Concurrent duplicate delivery skipped", { provider, eventType, externalId })
        return NextResponse.json({ success: true }, { status: 200 })
      } else {
        logger.info("Reprocessing stranded webhook event", { provider, eventType, externalId })
      }
    }

    // ── Phase 3: synchronous side effects (Tracks A/B/C) ────────────────────
    await processTracks(provider, externalId, eventType, payload)

    // Mark as processed only after all side effects succeed
    await markProcessed(provider, externalId)
  } catch (error) {
    // Transient processing failure — answer 5xx so the provider retries.
    // The unprocessed row remains; redelivery reprocesses it once the
    // in-flight window has passed.
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
 * Run Tracks A/B/C for a claimed webhook event.
 * Order is contractual: entitlements → license issuance → affiliate dispatch.
 */
async function processTracks(
  provider: "polar" | "razorpay",
  externalId: string,
  eventType: string,
  payload: unknown
): Promise<void> {
  if (provider === "polar") {
    const event = payload as Parameters<typeof processPolarEvent>[0]
    // Track A: billing entitlements
    if (isHandledPolarEvent(event.type)) {
      await processPolarEvent(event)
    }
    // Track B: license issuance for Local SKU one-time orders
    if (event.type === "order.paid") {
      await maybeIssueLicense(provider, String(event.data.id ?? ""), event.data)
    }
  } else {
    const event = payload as Parameters<typeof processRazorpayEvent>[0]
    // Track A: billing entitlements
    if (isHandledRazorpayEvent(event.event)) {
      await processRazorpayEvent(event)
    }
  }

  // Track C: affiliate commission/clawback dispatch (non-blocking on failure)
  const entityRecord =
    provider === "polar"
      ? ((payload as { data?: Record<string, unknown> }).data ?? {})
      : ((
          payload as {
            payload?: { payment?: { entity: unknown }; subscription?: { entity: unknown } }
          }
        ).payload?.payment?.entity ??
        (payload as { payload?: { subscription?: { entity: unknown } } }).payload?.subscription
          ?.entity ??
        {})
  await dispatchAffiliate({
    provider,
    event: eventType,
    payload: entityRecord as Record<string, unknown>,
  }).catch((err) => {
    logger.error("Affiliate dispatch failed (non-blocking)", {
      provider,
      event: eventType,
      externalId,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

/**
 * Check if a Polar order is for a Local SKU product and issue a license if so.
 * Called on `order.paid` events. Idempotent — the license issue endpoint
 * checks for existing licenses by orderId.
 */
async function maybeIssueLicense(
  provider: string,
  orderId: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const productId = (payload.product_id ??
      payload.productId ??
      payload.sku_id ??
      payload.skuId) as string | undefined
    if (!productId) return

    const skuId = resolveProviderKey(env.POLAR_LOCAL_PRODUCT_IDS, productId) as LocalSkuId | null
    if (!skuId || !LOCAL_SKU_MAP[skuId]) return

    const customer = payload.customer as Record<string, unknown> | undefined
    const buyerEmail = (payload.customer_email ??
      payload.customerEmail ??
      payload.email ??
      customer?.email) as string | undefined
    if (!buyerEmail) {
      logger.warn("Local SKU order missing buyer email — cannot issue license", {
        orderId,
        productId,
      })
      return
    }

    const seatCount = (payload.seats ?? payload.seat_count ?? payload.seatCount ?? 1) as number

    // Log bounded identifiers only — never buyer email or other customer PII.
    logger.info("Issuing license for Local SKU order", {
      orderId,
      productId,
      sku: skuId,
    })

    await issueLicenseForPolarOrder({
      productId,
      buyerEmail,
      seatCount,
      orderId,
    })
  } catch (error) {
    // Non-blocking — license issuance failure should not block the webhook
    logger.error("License issuance failed (non-blocking)", {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Insert a WebhookEvent row, idempotent on (provider, externalId).
 * The DB unique constraint arbitrates concurrent duplicates: exactly one
 * caller inserts. Returns false to signal a duplicate/replay.
 */
async function insertWebhookEvent(
  provider: string,
  externalId: string,
  identitySource: "delivery" | "derived",
  eventType: string,
  payload: unknown
): Promise<boolean> {
  try {
    await prisma.webhookEvent.create({
      data: {
        provider,
        externalId,
        eventType,
        payload: payload as Record<string, unknown>,
        processed: false,
        identitySource,
      },
    })
    return true
  } catch (error) {
    // P2002 = unique constraint — duplicate delivery, arbiter says we lost
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      logger.debug("Webhook event duplicate (constraint arbiter)", { provider, externalId })
      return false
    }
    throw error
  }
}

/**
 * Mark a WebhookEvent as processed after all synchronous side effects succeed.
 */
async function markProcessed(provider: string, externalId: string): Promise<void> {
  await prisma.webhookEvent.updateMany({
    where: { provider, externalId, processed: false },
    data: { processed: true, processedAt: new Date() },
  })
}
