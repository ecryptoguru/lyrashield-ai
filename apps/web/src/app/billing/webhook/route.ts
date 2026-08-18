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
 * 4. Process the event asynchronously
 *
 * TODO: dispatch to packages/affiliate webhook-dispatch when Track C lands
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

  try {
    if (hasPolarHeaders) {
      provider = "polar"
      const event = validatePolarWebhook(body, headers)
      externalId = (event.data.id as string) ?? crypto.randomUUID()
      eventType = event.type
      payload = event

      // Insert webhook event (idempotent)
      await insertWebhookEvent(provider, externalId, eventType, payload)

      // Respond 200 fast, process async
      processAsync(async () => {
        if (isHandledPolarEvent(event.type)) {
          await processPolarEvent(event)
        }
      })

      // TODO: dispatch to packages/affiliate webhook-dispatch when Track C lands
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

      // Insert webhook event (idempotent)
      await insertWebhookEvent(provider, externalId, eventType, payload)

      // Respond 200 fast, process async
      processAsync(async () => {
        if (isHandledRazorpayEvent(event.event)) {
          await processRazorpayEvent(event)
        }
      })

      // TODO: dispatch to packages/affiliate webhook-dispatch when Track C lands
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
