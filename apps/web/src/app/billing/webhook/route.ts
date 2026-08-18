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

/**
 * Billing webhook handler — accepts both Polar and Razorpay webhooks.
 *
 * The provider is determined by the presence of Polar-specific headers
 * (webhooks-id) vs Razorpay-specific headers (X-Razorpay-Signature).
 *
 * Flow:
 * 1. Validate signature
 * 2. Insert WebhookEvent (idempotent on @@unique([provider, externalId]))
 * 3. Respond 200 fast
 * 4. Process the event asynchronously:
 *    a. Track A: syncSubscription / creditTopUp (billing entitlements)
 *    b. Track B: issue license for Local SKU Polar one-time orders
 *    c. Track C: affiliate commission/clawback via webhook-dispatch
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
      { success: false, error: { code: "UNKNOWN_PROVIDER", message: "Unrecognized webhook provider" } },
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
      await insertWebhookEvent(provider, externalId, eventType, payload)

      // Respond 200 fast, process async
      processAsync(async () => {
        // Track A: billing entitlements
        if (isHandledPolarEvent(event.type)) {
          await processPolarEvent(event)
        }

        // Track B: license issuance for Local SKU one-time orders
        if (event.type === "order.paid") {
          await maybeIssueLicense(provider, externalId, payloadRecord)
        }

        // Track C: affiliate commission/clawback dispatch
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
      })
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
      await insertWebhookEvent(provider, externalId, eventType, payload)

      // Respond 200 fast, process async
      processAsync(async () => {
        // Track A: billing entitlements
        if (isHandledRazorpayEvent(event.event)) {
          await processRazorpayEvent(event)
        }

        // Track C: affiliate commission/clawback dispatch
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
      })
    }
  } catch (error) {
    logger.error("Webhook validation/processing failed", {
      provider: hasPolarHeaders ? "polar" : "razorpay",
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { success: false, error: { code: "WEBHOOK_VALIDATION_FAILED", message: "Invalid webhook" } },
      { status: 400 }
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
      logger.warn("Local SKU order missing buyer email — cannot issue license", { externalId, productId })
      return
    }

    const seatCount = (payload.seatCount as number) ?? 1
    const sku = Object.values(LOCAL_SKU_MAP).find((s) => s.id === productId) as
      | { id: LocalSkuId }
      | undefined
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
 * If the event already exists, it's a replay — return without error.
 */
async function insertWebhookEvent(
  provider: string,
  externalId: string,
  eventType: string,
  payload: unknown
): Promise<void> {
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
  } catch (error) {
    // P2002 = unique constraint — replay, ignore
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      logger.debug("Webhook event replay (already processed)", { provider, externalId })
      return
    }
    throw error
  }
}

/**
 * Process an async task without blocking the webhook response.
 * In production, this should be a BullMQ job; for now, we use a fire-and-forget
 * promise with error logging.
 */
function processAsync(fn: () => Promise<void>): void {
  fn().catch((error) => {
    logger.error("Async webhook processing failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}
