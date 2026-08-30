type WebhookEventCandidate = {
  externalId: string
  eventType: string
  payload: unknown
}

function subscriptionIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const subscription = (payload as { payload?: { subscription?: { entity?: { id?: unknown } } } })
    .payload?.subscription?.entity
  return typeof subscription?.id === "string" ? subscription.id : null
}

/**
 * Prefer the one processed Razorpay charge for a hosted subscription. Test
 * subscriptions can instead deliver only one activation webhook; accept that
 * lifecycle receipt only when no matching charge exists. Ambiguity fails closed.
 */
export function selectRazorpaySubscriptionReceiptEvent(
  candidates: WebhookEventCandidate[],
  subscriptionId: string
): { externalId: string; eventType: "subscription.charged" | "subscription.activated" } {
  const matches = candidates.filter(
    (candidate) => subscriptionIdFromPayload(candidate.payload) === subscriptionId
  )
  const charges = matches.filter((candidate) => candidate.eventType === "subscription.charged")
  if (charges.length === 1) {
    return { externalId: charges[0]!.externalId, eventType: "subscription.charged" }
  }
  const activations = matches.filter(
    (candidate) => candidate.eventType === "subscription.activated"
  )
  if (charges.length === 0 && activations.length === 1) {
    return { externalId: activations[0]!.externalId, eventType: "subscription.activated" }
  }
  {
    throw new Error(
      `Provider receipt could not resolve one Razorpay subscription receipt event (charges ${charges.length}, activations ${activations.length})`
    )
  }
}

/** Resolve one provider-delivered cancellation for the exact subscription. */
export function selectRazorpaySubscriptionCancellationEvent(
  candidates: WebhookEventCandidate[],
  subscriptionId: string
): { externalId: string; eventType: "subscription.cancelled" } {
  const cancellations = candidates.filter(
    (candidate) =>
      candidate.eventType === "subscription.cancelled" &&
      subscriptionIdFromPayload(candidate.payload) === subscriptionId
  )
  if (cancellations.length !== 1) {
    throw new Error(
      `Provider receipt could not resolve one Razorpay subscription cancellation event (cancellations ${cancellations.length})`
    )
  }
  return { externalId: cancellations[0]!.externalId, eventType: "subscription.cancelled" }
}
