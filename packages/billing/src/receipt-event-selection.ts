type WebhookEventCandidate = {
  externalId: string
  payload: unknown
}

function subscriptionIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const subscription = (payload as { payload?: { subscription?: { entity?: { id?: unknown } } } })
    .payload?.subscription?.entity
  return typeof subscription?.id === "string" ? subscription.id : null
}

/**
 * Select only the one processed Razorpay charge that belongs to this hosted
 * subscription. Ambiguity fails closed rather than trusting log output.
 */
export function selectRazorpaySubscriptionChargeEvent(
  candidates: WebhookEventCandidate[],
  subscriptionId: string
): string {
  const matches = candidates.filter(
    (candidate) => subscriptionIdFromPayload(candidate.payload) === subscriptionId
  )
  if (matches.length !== 1) {
    throw new Error("Provider receipt could not resolve one Razorpay subscription charge event")
  }
  return matches[0]!.externalId
}
