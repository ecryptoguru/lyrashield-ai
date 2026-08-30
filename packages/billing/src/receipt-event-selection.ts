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

function polarSubscriptionIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null
  const id = (payload as { data?: { id?: unknown } }).data?.id
  return typeof id === "string" ? id : null
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

/** Prefer one active Polar subscription receipt, falling back to creation. */
export function selectPolarSubscriptionReceiptEvent(
  candidates: WebhookEventCandidate[],
  subscriptionId: string
): { externalId: string; eventType: "subscription.active" | "subscription.created" } {
  const matches = candidates.filter(
    (candidate) => polarSubscriptionIdFromPayload(candidate.payload) === subscriptionId
  )
  const active = matches.filter((candidate) => candidate.eventType === "subscription.active")
  if (active.length === 1) {
    return { externalId: active[0]!.externalId, eventType: "subscription.active" }
  }
  const created = matches.filter((candidate) => candidate.eventType === "subscription.created")
  if (active.length === 0 && created.length === 1) {
    return { externalId: created[0]!.externalId, eventType: "subscription.created" }
  }
  throw new Error(
    `Provider receipt could not resolve one Polar subscription receipt event (active ${active.length}, created ${created.length})`
  )
}

/** Resolve one provider-delivered Polar cancellation for the exact subscription. */
export function selectPolarSubscriptionCancellationEvent(
  candidates: WebhookEventCandidate[],
  subscriptionId: string
): { externalId: string; eventType: "subscription.canceled" | "subscription.revoked" } {
  const matches = candidates.filter(
    (candidate) =>
      ["subscription.canceled", "subscription.revoked"].includes(candidate.eventType) &&
      polarSubscriptionIdFromPayload(candidate.payload) === subscriptionId
  )
  const revoked = matches.filter((candidate) => candidate.eventType === "subscription.revoked")
  if (revoked.length === 1) {
    return { externalId: revoked[0]!.externalId, eventType: "subscription.revoked" }
  }
  const canceled = matches.filter((candidate) => candidate.eventType === "subscription.canceled")
  if (revoked.length === 0 && canceled.length === 1) {
    return { externalId: canceled[0]!.externalId, eventType: "subscription.canceled" }
  }
  throw new Error(
    `Provider receipt could not resolve one Polar subscription cancellation event (revoked ${revoked.length}, canceled ${canceled.length})`
  )
}

export function isProviderSubscriptionLifecycleReceipt(params: {
  provider: "polar" | "razorpay"
  phase: string
  eventType: string
  status: string
  canceledAt: boolean
}): boolean {
  if (params.phase === "purchase") {
    return params.provider === "razorpay"
      ? ["subscription.charged", "subscription.activated"].includes(params.eventType)
      : ["subscription.active", "subscription.created"].includes(params.eventType)
  }
  if (params.phase !== "cancellation") return true
  return params.provider === "razorpay"
    ? params.eventType === "subscription.cancelled" && params.status === "canceled"
    : ["subscription.canceled", "subscription.revoked"].includes(params.eventType) &&
        (params.status === "canceled" || params.canceledAt)
}
