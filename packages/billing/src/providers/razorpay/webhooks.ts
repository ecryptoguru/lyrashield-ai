/**
 * Razorpay webhook signature validation.
 *
 * Razorpay signs webhooks with HMAC-SHA256 using the webhook secret.
 * The signature is in the `X-Razorpay-Signature` header.
 *
 * The signed payload is the raw request body.
 *
 * Handled events:
 * - payment.captured → creditTopUp (for one-time pack purchases)
 * - subscription.activated → syncSubscription
 * - subscription.charged → syncSubscription + grantMonthlyPool
 * - subscription.authenticated → receipt only (no entitlement)
 * - subscription.halted → syncSubscription (past_due)
 * - subscription.cancelled → syncSubscription (canceled)
 * - subscription.paused → syncSubscription (paused)
 * - subscription.pending → syncSubscription (past_due)
 * - subscription.resumed → syncSubscription (active)
 * - subscription.completed → end paid access
 * - subscription.updated → receipt only (no inferred state)
 * - refund.created → reverseRefund only with cumulative full-refund evidence
 */

import { createHash, createHmac } from "node:crypto"
import { env } from "@lyrashield/config"
import { z } from "zod"
import { WebhookAuthError, WebhookPayloadError } from "../../webhook-errors"

const notesSchema = z.preprocess(
  (value) => (Array.isArray(value) && value.length === 0 ? {} : value),
  z.record(z.string(), z.string()).nullish()
)

const paymentEntitySchema = z
  .object({
    id: z.string(),
    amount: z.number(),
    currency: z.string(),
    notes: notesSchema,
    email: z.string().optional(),
    order_id: z.string().nullish(),
    amount_refunded: z.number().optional(),
    amountRefunded: z.number().optional(),
    refund_status: z.string().nullish(),
    refundStatus: z.string().nullish(),
    status: z.string().optional(),
  })
  .passthrough()

const razorpayWebhookEventSchema = z
  .object({
    event: z.string().min(1),
    /** Razorpay includes the original event creation time in Unix seconds. */
    created_at: z.number().optional(),
    payload: z
      .object({
        payment: z.object({ entity: paymentEntitySchema }).passthrough().optional(),
        refund: z
          .object({
            entity: z
              .object({
                id: z.string(),
                payment_id: z.string(),
                amount: z.number().optional(),
                currency: z.string().optional(),
                status: z.string().optional(),
              })
              .passthrough(),
          })
          .passthrough()
          .optional(),
        order: z
          .object({ entity: z.object({ id: z.string() }).passthrough() })
          .passthrough()
          .optional(),
        subscription: z
          .object({
            entity: z
              .object({
                id: z.string(),
                status: z.string(),
                plan_id: z.string(),
                current_start: z.number().nullish(),
                current_end: z.number().nullish(),
                ended_at: z.number().nullish(),
                notes: notesSchema,
              })
              .passthrough(),
          })
          .passthrough()
          .optional(),
        payment_link: z
          .object({
            entity: z
              .object({
                id: z.string(),
                reference_id: z.string().nullish(),
                notes: notesSchema,
              })
              .passthrough(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough()

export type RazorpayWebhookEvent = z.infer<typeof razorpayWebhookEventSchema>

const MAX_PROVIDER_REPLAY_AGE_MS = 15 * 24 * 60 * 60 * 1000
const MAX_PROVIDER_CLOCK_SKEW_MS = 5 * 60 * 1000

/**
 * Validate a Razorpay webhook signature.
 *
 * Security:
 * - Uses RAZORPAY_WEBHOOK_SECRET exclusively (never falls back to the API key
 *   secret, which has a different purpose and would weaken webhook validation).
 * - Rejects events older than the 15-day provider replay window or too far in
 *   the future to prevent replay attacks.
 *
 * @param body - Raw request body string
 * @param signature - Value of X-Razorpay-Signature header
 * @returns The parsed event, or throws if validation fails.
 */
export function validateRazorpayWebhook(body: string, signature: string): RazorpayWebhookEvent {
  const secrets = [env.RAZORPAY_WEBHOOK_SECRET, env.RAZORPAY_WEBHOOK_PREVIOUS_SECRET].filter(
    (secret): secret is string => Boolean(secret)
  )
  if (secrets.length === 0) {
    throw new WebhookAuthError("not_configured", "RAZORPAY_WEBHOOK_SECRET is not configured")
  }

  if (!signature) {
    throw new WebhookAuthError("missing_signature", "Missing X-Razorpay-Signature header")
  }

  // HMAC-SHA256 of the raw body
  // Razorpay retries an event after a webhook-secret rotation with the old
  // signing secret. Keep exactly one previous secret during that retry window.
  const isValid = secrets.some((secret) => {
    const expectedSig = createHmac("sha256", secret).update(body).digest("hex")
    return timingSafeEqual(signature, expectedSig)
  })
  if (!isValid) {
    throw new WebhookAuthError("invalid_signature", "Invalid Razorpay webhook signature")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new WebhookPayloadError("Razorpay webhook body is not valid JSON")
  }
  const event = razorpayWebhookEventSchema.safeParse(parsed)
  if (!event.success) throw new WebhookPayloadError("Razorpay webhook has invalid event shape")
  const validated = event.data

  // `created_at` is the original event time. Razorpay can retry a signed
  // payload for 24 hours and supports replay requests for 15 days. Accept that
  // documented window; stable provider event IDs and database uniqueness make
  // delayed duplicate deliveries idempotent.
  const createdAt = validated.created_at
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new WebhookPayloadError("Razorpay webhook missing valid created_at")
  }
  const eventAgeMs = Date.now() - createdAt * 1000
  if (eventAgeMs < -MAX_PROVIDER_CLOCK_SKEW_MS) {
    throw new WebhookAuthError("stale_timestamp", "Razorpay webhook timestamp is in the future")
  }
  if (eventAgeMs > MAX_PROVIDER_REPLAY_AGE_MS) {
    throw new WebhookAuthError("stale_timestamp", "Razorpay webhook exceeds replay window")
  }

  return validated
}

/**
 * Resolve the dedupe identity for a Razorpay delivery.
 *
 * Priority:
 * 1. `X-Razorpay-Event-ID` request header — Razorpay's per-delivery event id.
 *    Distinct per delivery, stable across redeliveries of the same event.
 * 2. Deterministic digest of `${event}|${primaryResourceId}|${created_at}` —
 *    same logical redelivery yields the same id; different lifecycle events on
 *    one subscription differ (event type and/or occurrence timestamp change).
 *
 * Returns null when the payload carries no primary resource id — callers must
 * treat that as malformed_payload, never fall back to random ids.
 */
export function resolveRazorpayEventIdentity(
  event: RazorpayWebhookEvent,
  headerEventId: string | undefined
): { externalId: string; identitySource: "delivery" | "derived" } | null {
  const trimmed = headerEventId?.trim()
  if (trimmed) {
    return { externalId: trimmed, identitySource: "delivery" }
  }

  const resourceId =
    event.payload.refund?.entity.id ??
    event.payload.payment?.entity.id ??
    event.payload.subscription?.entity.id ??
    event.payload.order?.entity.id

  if (!resourceId || !event.created_at) return null

  const externalId = createHash("sha256")
    .update(`${event.event}|${resourceId}|${event.created_at}`)
    .digest("hex")
  return { externalId, identitySource: "derived" }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

/**
 * Check if a Razorpay event type is one we handle.
 */
export function isHandledRazorpayEvent(event: string): boolean {
  const handled = [
    "payment.captured",
    "payment_link.paid",
    "subscription.authenticated",
    "subscription.activated",
    "subscription.charged",
    "subscription.pending",
    "subscription.halted",
    "subscription.paused",
    "subscription.resumed",
    "subscription.cancelled",
    "subscription.completed",
    "subscription.updated",
    "refund.created",
  ]
  return handled.includes(event)
}
