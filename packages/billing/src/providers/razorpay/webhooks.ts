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

/**
 * Validate a Razorpay webhook signature.
 *
 * @param body - Raw request body string
 * @param signature - Value of X-Razorpay-Signature header
 * @returns The parsed event, or throws if validation fails.
 */
export function validateRazorpayWebhook(
  body: string,
  signature: string
): RazorpayWebhookEvent {
  const secret = env.RAZORPAY_WEBHOOK_SECRET ?? env.RAZORPAY_KEY_SECRET
  if (!secret) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET (or RAZORPAY_KEY_SECRET) is not configured")
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
