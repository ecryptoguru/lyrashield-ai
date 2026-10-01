/**
 * Durable rejection receipts for authentic provider webhook deliveries that
 * fail catalog validation.
 *
 * Trust boundary: a receipt is written ONLY after the provider signature has
 * been validated and a stable external identity (delivery id or derived
 * resource digest) has been resolved. Signature/identity failures and
 * unidentifiable malformed payloads never produce receipts.
 *
 * Stored fields are bounded identifiers only — provider, external identity,
 * event type, reason code, observation time. Never raw payloads, emails,
 * account secrets, or tenant binding.
 *
 * Semantics:
 * - (provider, externalId) is unique: rejected replays stay one record and the
 *   original observation is never overwritten.
 * - A receipt is never recorded when an accepted WebhookEvent already owns the
 *   identity — a rejection may not overlay an accepted receipt.
 * - Rejection rows are not processable receipts: no WebhookEvent row exists
 *   for them, so entitlement/license/affiliate tracks can never reach them.
 * - A later valid delivery with the same identity still enters exactly-once
 *   fulfillment through the normal WebhookEvent claim path.
 * - Persistence failure throws: callers answer a retriable 5xx rather than
 *   claim a durable rejection that never happened.
 */

import { getSystemPrisma } from "@lyrashield/db"

/** Bounded, log-safe reason codes persisted on rejection receipts. */
export const WEBHOOK_REJECTION_REASONS = {
  /** Signed + identifiable delivery whose catalog evidence did not verify. */
  catalogEvidenceMismatch: "catalog_evidence_mismatch",
} as const

export type WebhookRejectionReason =
  (typeof WEBHOOK_REJECTION_REASONS)[keyof typeof WEBHOOK_REJECTION_REASONS]

export interface WebhookRejectionInput {
  provider: "polar" | "razorpay"
  /** WebhookEvent.externalId-equivalent identity of the rejected delivery. */
  externalId: string
  identitySource: "delivery" | "derived"
  eventType: string
  reasonCode: WebhookRejectionReason
}

export type WebhookRejectionOutcome = "recorded" | "duplicate" | "accepted_receipt_exists"

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  )
}

/**
 * Persist one durable rejection receipt for a signature-valid, identifiable
 * delivery rejected by catalog validation.
 *
 * @returns "recorded" on first observation, "duplicate" when the same identity
 *   was already rejected, "accepted_receipt_exists" when an accepted
 *   WebhookEvent already owns the identity (no rejection is written).
 * @throws when storage fails — the caller must answer a retriable 5xx.
 */
export async function recordWebhookRejection(
  input: WebhookRejectionInput
): Promise<WebhookRejectionOutcome> {
  // System-owned global table; the tenant runtime role has no access. Use the
  // privileged client so no workspace context is required or implied.
  const db = getSystemPrisma()

  const accepted = await db.webhookEvent.findUnique({
    where: {
      provider_externalId: { provider: input.provider, externalId: input.externalId },
    },
    select: { id: true },
  })
  if (accepted) return "accepted_receipt_exists"

  try {
    await db.webhookEventRejection.create({
      data: {
        provider: input.provider,
        externalId: input.externalId,
        identitySource: input.identitySource,
        eventType: input.eventType,
        reasonCode: input.reasonCode,
      },
    })
    return "recorded"
  } catch (error) {
    // Rejected replays dedupe on (provider, externalId) — the first bounded
    // observation stands; nothing is updated or overwritten.
    if (isUniqueViolation(error)) return "duplicate"
    throw error
  }
}
