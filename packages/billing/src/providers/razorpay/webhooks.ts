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
 * - subscription.cancelled → syncSubscription (canceled)
 * - subscription.paused → syncSubscription (paused)
 * - subscription.pending → syncSubscription (past_due)
 */

import { createHmac } from "node:crypto"
import { env } from "@lyrashield/config"

export interface RazorpayWebhookEvent {
  event: string
  /** Razorpay includes a top-level timestamp (Unix seconds) for replay protection. */
  created_at?: number
  payload: {
    payment?: {
      entity: {
        id: string
        amount: number
        currency: string
        notes?: Record<string, string>
      }
    }
    subscription?: {
      entity: {
        id: string
        status: string
        plan_id: string
        current_start?: number
        current_end?: number
        ended_at?: number
        notes?: Record<string, string>
      }
    }
  }
}

/** Default webhook tolerance in milliseconds (5 minutes). */
const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000

/**
 * Validate a Razorpay webhook signature.
 *
 * Security:
 * - Uses RAZORPAY_WEBHOOK_SECRET exclusively (never falls back to the API key
 *   secret, which has a different purpose and would weaken webhook validation).
 * - Rejects events older than 5 minutes to prevent replay attacks.
 *
 * @param body - Raw request body string
 * @param signature - Value of X-Razorpay-Signature header
 * @returns The parsed event, or throws if validation fails.
 */
export function validateRazorpayWebhook(
  body: string,
  signature: string
): RazorpayWebhookEvent {
  const secret = env.RAZORPAY_WEBHOOK_SECRET
  if (!secret) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET is not configured")
  }

  if (!signature) {
    throw new Error("Missing X-Razorpay-Signature header")
  }

  // HMAC-SHA256 of the raw body
  const expectedSig = createHmac("sha256", secret).update(body).digest("hex")

  if (!timingSafeEqual(signature, expectedSig)) {
    throw new Error("Invalid Razorpay webhook signature")
  }

  const parsed = JSON.parse(body) as RazorpayWebhookEvent

  // A-L01: Timestamp tolerance: reject events older than 5 minutes to prevent
  // replay. Razorpay includes a top-level `created_at` field (Unix seconds).
  // The check is now MANDATORY — previously, if created_at was absent the
  // replay check was silently skipped, allowing old payloads to be replayed.
  if (parsed.created_at === undefined || parsed.created_at === null) {
    throw new Error("Razorpay webhook missing created_at — cannot verify timestamp")
  }
  const eventTimestampMs = parsed.created_at * 1000
  const ageMs = Date.now() - eventTimestampMs
  if (ageMs > DEFAULT_TOLERANCE_MS) {
    throw new Error(`Razorpay webhook timestamp outside tolerance (${ageMs}ms > ${DEFAULT_TOLERANCE_MS}ms)`)
  }

  return parsed
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
    "subscription.activated",
    "subscription.charged",
    "subscription.cancelled",
    "subscription.paused",
    "subscription.pending",
    "payment.refunded",
  ]
  return handled.includes(event)
}
