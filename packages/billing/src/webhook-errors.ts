/**
 * Typed webhook validation failures.
 *
 * Lets the webhook route classify responses without string-matching error
 * messages:
 * - AUTH-class (missing/invalid signature, stale/anti-replay timestamp):
 *   non-retryable 401/400 — retrying can never succeed.
 * - PAYLOAD-class (signature valid, body unparseable or missing required
 *   fields): non-retryable 400.
 * - Anything else escaping validation is treated as a transient processing
 *   failure and answered 5xx so the provider retries.
 *
 * Never include raw bodies, signatures, or customer data in these messages —
 * they are logged verbatim.
 */

export type WebhookAuthReason =
  "missing_signature" | "invalid_signature" | "stale_timestamp" | "not_configured"

/** Signature/auth-layer rejection — provider must NOT retry. */
export class WebhookAuthError extends Error {
  readonly reason: WebhookAuthReason

  constructor(reason: WebhookAuthReason, message: string) {
    super(message)
    this.name = "WebhookAuthError"
    this.reason = reason
  }
}

/** Signature OK but payload unusable — provider must NOT retry. */
export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WebhookPayloadError"
  }
}
