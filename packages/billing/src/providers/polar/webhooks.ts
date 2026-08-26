/**
 * Polar webhook validation and event handling.
 *
 * Uses Standard Webhooks specification for signature validation.
 * The webhook secret is read from POLAR_WEBHOOK_SECRET.
 *
 * Handled events:
 * - order.paid → creditTopUp (for one-time pack purchases)
 * - subscription.created → syncSubscription
 * - subscription.updated → syncSubscription
 * - subscription.active → syncSubscription
 * - subscription.canceled → syncSubscription (canceled)
 * - subscription.revoked → syncSubscription (canceled)
 * - subscription.uncanceled → syncSubscription (reactivated)
 * - customer.state_changed → syncSubscription
 * - refund.created → recorded without mutation
 * - order.refunded → reverseRefund only when full and for a minute pack
 */

import { createHmac } from "node:crypto"
import { env } from "@lyrashield/config"
import { WebhookAuthError, WebhookPayloadError } from "../../webhook-errors"

/** Default webhook tolerance in milliseconds (5 minutes). */
const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000

export interface PolarWebhookEvent {
  type: string
  data: Record<string, unknown>
}

/**
 * Validate a Polar webhook signature using Standard Webhooks spec.
 *
 * Headers:
 * - webhook-id: unique event ID (legacy `webhooks-*` aliases are accepted)
 * - webhook-timestamp: Unix timestamp in seconds
 * - webhook-signature: base64 HMAC-SHA256 of `{id}.{timestamp}.{body}`
 *
 * @returns The parsed event, or throws if validation fails.
 */
export function validatePolarWebhook(
  body: string,
  headers: Record<string, string | string[] | undefined>
): PolarWebhookEvent {
  const secret = env.POLAR_WEBHOOK_SECRET
  if (!secret) {
    throw new WebhookAuthError("not_configured", "POLAR_WEBHOOK_SECRET is not configured")
  }

  const eventId = getWebhookHeader(headers, "id")
  const timestamp = getWebhookHeader(headers, "timestamp")
  const signature = getWebhookHeader(headers, "signature")

  if (!eventId || !timestamp || !signature) {
    throw new WebhookAuthError("missing_signature", "Missing required webhook headers")
  }

  // Check timestamp tolerance
  if (!/^\d+$/.test(timestamp)) {
    throw new WebhookAuthError("invalid_signature", "Invalid webhook timestamp")
  }
  const ts = Number(timestamp)

  const tolerance = env.POLAR_WEBHOOK_TOLERANCE_MS ?? DEFAULT_TOLERANCE_MS
  const ageMs = Date.now() - ts * 1000
  if (Math.abs(ageMs) > tolerance) {
    throw new WebhookAuthError(
      "stale_timestamp",
      `Webhook timestamp outside tolerance (${ageMs}ms, tolerance ${tolerance}ms)`
    )
  }

  // Verify signature: HMAC-SHA256 of `{id}.{timestamp}.{body}`
  const signedPayload = `${eventId}.${timestamp}.${body}`
  const signingKey = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  if (signingKey.length === 0) {
    throw new WebhookAuthError("not_configured", "Invalid POLAR_WEBHOOK_SECRET")
  }
  const expectedSig = createHmac("sha256", signingKey).update(signedPayload).digest("base64")

  // The signature header may contain multiple signatures (space-separated, prefixed with "v1,")
  const signatures = signature
    .split(" ")
    .flatMap((value) => (value.startsWith("v1,") ? [value.slice(3)] : []))
  const isValid = signatures.some((sig) => timingSafeEqual(sig, expectedSig))

  if (!isValid) {
    throw new WebhookAuthError("invalid_signature", "Invalid webhook signature")
  }

  let parsed: PolarWebhookEvent
  try {
    parsed = JSON.parse(body) as PolarWebhookEvent
  } catch {
    throw new WebhookPayloadError("Polar webhook body is not valid JSON")
  }
  return parsed
}

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
}

function getWebhookHeader(
  headers: Record<string, string | string[] | undefined>,
  name: "id" | "timestamp" | "signature"
): string {
  return getHeader(headers, `webhook-${name}`) || getHeader(headers, `webhooks-${name}`)
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
 * Check if a Polar event type is one we handle.
 */
export function isHandledPolarEvent(type: string): boolean {
  const handled = [
    "order.paid",
    "subscription.created",
    "subscription.updated",
    "subscription.active",
    "subscription.paused",
    "subscription.resumed",
    "subscription.past_due",
    "subscription.canceled",
    "subscription.revoked",
    "subscription.uncanceled",
    "customer.state_changed",
    "refund.created",
    "order.refunded",
  ]
  return handled.includes(type)
}
