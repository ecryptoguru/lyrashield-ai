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
} from "@lyrashield/billing"
import { dispatch as dispatchAffiliate } from "@lyrashield/affiliate"
import { LOCAL_SKU_MAP, type LocalSkuId } from "@lyrashield/pricing"
import { issueLicenseForPolarOrder } from "@/lib/licenses/license-service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Billing webhook handler — accepts both Polar and Razorpay webhooks.
 *
 * The provider is determined by the presence of Polar-specific headers
 * (webhooks-id) vs Razorpay-specific headers (X-Razorpay-Signature).
 *
 * Flow (synchronous, like the GitHub webhook):
 * 1. Validate signature
 * 2. Insert WebhookEvent (idempotent on @@unique([provider, externalId]))
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
export async function POST(request: Request) {
  const body = await request.text()
  const headers: Record<string, string | string[] | undefined> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })

  // Detect provider by headers
  const hasPolarHeaders = headers["webhooks-id"] !== undefined
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
  let eventType: string
  let payload: unknown
  let payloadRecord: Record<string, unknown>

  try {
    if (hasPolarHeaders) {
      provider = "polar"
      const event = validatePolarWebhook(body, headers)
      externalId = (event.data.id as string) ?? crypto.randomUUID()
      eventType = event.type
      payload = event
      payloadRecord = event.data as Record<string, unknown>

      // Insert webhook event (idempotent)
      const inserted = await insertWebhookEvent(provider, externalId, eventType, payload)
      if (!inserted) {
        // A-M04: Replay — check if the existing event was never processed.
        // If it's still unprocessed, reattempt processing instead of silently
        // returning 200 and permanently stranding the event.
        const existingEvent = await prisma.webhookEvent.findUnique({
          where: { provider_externalId: { provider, externalId } },
          select: { processed: true },
        })
        if (existingEvent?.processed) {
          return NextResponse.json({ success: true }, { status: 200 })
        }
        // Fall through to reprocess the unprocessed event
        logger.info("Reprocessing unprocessed webhook event", { provider, externalId })
      }

      // Process synchronously before responding
      // Track A: billing entitlements
      if (isHandledPolarEvent(event.type)) {
        await processPolarEvent(event)
      }

      // Track B: license issuance for Local SKU one-time orders
      if (event.type === "order.paid") {
        await maybeIssueLicense(provider, externalId, payloadRecord)
      }

      // Track C: affiliate commission/clawback dispatch (non-blocking on failure)
      await dispatchAffiliate({
        provider,
        event: eventType,
        payload: payloadRecord,
      }).catch((err) => {
        logger.error("Affiliate dispatch failed (non-blocking)", {
          provider,
          event: eventType,
          error: err instanceof Error ? err.message : String(err),
        })
      })

      // Mark as processed
      await markProcessed(provider, externalId)
    } else {
      provider = "razorpay"
      const signature = (headers["x-razorpay-signature"] as string) ?? ""
      const event = validateRazorpayWebhook(body, signature)
      externalId =
        event.payload.payment?.entity.id ??
        event.payload.subscription?.entity.id ??
        crypto.randomUUID()
      eventType = event.event
      payload = event
      payloadRecord = (event.payload.payment?.entity ??
        event.payload.subscription?.entity ??
        {}) as Record<string, unknown>

      // Insert webhook event (idempotent)
      const inserted = await insertWebhookEvent(provider, externalId, eventType, payload)
      if (!inserted) {
        // A-M04: Replay — check if the existing event was never processed.
        const existingEvent = await prisma.webhookEvent.findUnique({
          where: { provider_externalId: { provider, externalId } },
          select: { processed: true },
        })
        if (existingEvent?.processed) {
          return NextResponse.json({ success: true }, { status: 200 })
        }
        logger.info("Reprocessing unprocessed webhook event", { provider, externalId })
      }

      // Process synchronously before responding
      // Track A: billing entitlements
      if (isHandledRazorpayEvent(event.event)) {
        await processRazorpayEvent(event)
      }

      // Track C: affiliate commission/clawback dispatch (non-blocking on failure)
      await dispatchAffiliate({
        provider,
        event: eventType,
        payload: payloadRecord,
      }).catch((err) => {
        logger.error("Affiliate dispatch failed (non-blocking)", {
          provider,
          event: eventType,
          error: err instanceof Error ? err.message : String(err),
        })
      })

      // Mark as processed
      await markProcessed(provider, externalId)
    }
  } catch (error) {
    logger.error("Webhook validation/processing failed", {
      provider: hasPolarHeaders ? "polar" : "razorpay",
      error: error instanceof Error ? error.message : String(error),
    })
    // A-M04: Return 500 (not 400) on processing errors so the provider retries.
    // Returning 400 causes the provider to stop retrying, permanently stranding events.
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
 * Check if a Polar order is for a Local SKU product and issue a license if so.
 * Called on `order.paid` events. Idempotent — the license issue endpoint
 * checks for existing licenses by orderId.
 */
async function maybeIssueLicense(
  provider: string,
  externalId: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const productId = (payload.productId ?? payload.skuId) as string | undefined
    if (!productId) return

    // Check if this product ID maps to a Local SKU
    const isLocalSku = Object.values(LOCAL_SKU_MAP).some((sku) => sku.id === productId)
    if (!isLocalSku) return

    const buyerEmail = (payload.customerEmail ?? payload.email) as string | undefined
    if (!buyerEmail) {
      logger.warn("Local SKU order missing buyer email — cannot issue license", {
        externalId,
        productId,
      })
      return
    }

    const seatCount = (payload.seatCount as number) ?? 1
    const sku = Object.values(LOCAL_SKU_MAP).find((s) => s.id === productId) as
      { id: LocalSkuId } | undefined
    if (!sku) return

    logger.info("Issuing license for Local SKU order", {
      externalId,
      productId,
      sku: sku.id,
      buyerEmail,
    })

    await issueLicenseForPolarOrder({
      productId,
      buyerEmail,
      seatCount,
      orderId: externalId,
    })
  } catch (error) {
    // Non-blocking — license issuance failure should not block the webhook
    logger.error("License issuance failed (non-blocking)", {
      externalId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Insert a WebhookEvent row, idempotent on (provider, externalId).
 * If the event already exists, it's a replay — return false to signal skip.
 * Returns true if the row was newly inserted.
 */
async function insertWebhookEvent(
  provider: string,
  externalId: string,
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
      },
    })
    return true
  } catch (error) {
    // P2002 = unique constraint — replay, ignore
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      logger.debug("Webhook event replay (already processed)", { provider, externalId })
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
