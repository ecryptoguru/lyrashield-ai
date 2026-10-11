import type { SyncSubscriptionParams } from "./sync"

type PersistedSubscription = {
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  lastEventAt: Date | null
  status: string
}

/** Evaluated under the account advisory lock, before entitlement or allowance writes. */
export function shouldApplySubscriptionEvent(
  {
    provider,
    status,
    currentPeriodStart,
    currentPeriodEnd,
    eventOccurredAt,
  }: SyncSubscriptionParams,
  persisted: PersistedSubscription | null
): boolean {
  const stale =
    (eventOccurredAt !== undefined &&
      persisted?.lastEventAt !== undefined &&
      persisted.lastEventAt !== null &&
      eventOccurredAt < persisted.lastEventAt) ||
    (currentPeriodStart !== undefined &&
      persisted?.currentPeriodStart !== undefined &&
      persisted.currentPeriodStart !== null &&
      currentPeriodStart < persisted.currentPeriodStart)
  if (stale) return false
  // Polar termination is irreversible for this subscription id. Redelivered
  // or same-clock active snapshots must never revive an ended contract or
  // grant a new monthly pool; a new checkout has a distinct contract id.
  const polarContractEnded =
    provider === "polar" &&
    persisted?.status === "canceled" &&
    persisted.currentPeriodEnd != null &&
    persisted.lastEventAt != null &&
    persisted.currentPeriodEnd <= persisted.lastEventAt
  if (
    polarContractEnded &&
    (status !== "canceled" ||
      (currentPeriodEnd !== undefined &&
        persisted.currentPeriodEnd !== null &&
        currentPeriodEnd > persisted.currentPeriodEnd))
  )
    return false

  return true
}
