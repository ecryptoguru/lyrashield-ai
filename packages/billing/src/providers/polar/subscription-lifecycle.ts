import type { SubscriptionStatus } from "../../sync"

/** Preserve scheduled paid terms while capping irreversible Polar termination. */
export function resolvePolarSubscriptionLifecycle(
  eventType: string,
  data: Record<string, unknown>
) {
  const status = mapPolarSubscriptionStatus(eventType, data)

  const currentPeriodStart = data.current_period_start ?? data.currentPeriodStart
  const currentPeriodEnd = data.current_period_end ?? data.currentPeriodEnd
  const canceledAtValue = data.canceled_at ?? data.canceledAt
  const endedAtValue = data.ended_at ?? data.endedAt
  const modifiedAtValue = data.modified_at ?? data.modifiedAt
  const periodStart = parseOptionalTime(currentPeriodStart)
  let periodEnd = parseOptionalTime(currentPeriodEnd)
  const canceledAt = parseOptionalTime(canceledAtValue)
  const eventOccurredAt = new Date(String(modifiedAtValue ?? ""))
  if (Number.isNaN(eventOccurredAt.getTime())) {
    throw new Error("polar_subscription_event_time_invalid")
  }
  const endedAt = endedAtValue != null ? new Date(endedAtValue as string) : undefined
  if (endedAt && (!Number.isFinite(endedAt.getTime()) || endedAt > eventOccurredAt)) {
    throw new Error("polar_subscription_end_time_invalid")
  }
  if (endedAt && status !== "canceled") {
    throw new Error("polar_subscription_end_state_invalid")
  }
  // Polar revocation ends benefits immediately; scheduled cancellation
  // remains active through the paid term. Follow-up updated events carry
  // ended_at too, so they cannot reopen the original future paid term.
  const terminatedAt =
    endedAt ??
    (eventType === "subscription.revoked" ||
    data.status === "unpaid" ||
    data.status === "incomplete_expired"
      ? eventOccurredAt
      : undefined)
  if (status === "canceled" && terminatedAt) {
    periodEnd = periodEnd && periodEnd < terminatedAt ? periodEnd : terminatedAt
  }

  return {
    status,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    canceledAt,
    eventOccurredAt,
  }
}

function parseOptionalTime(value: unknown): Date | undefined {
  if (value == null) return undefined
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("polar_subscription_time_invalid")
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error("polar_subscription_time_invalid")
  return date
}

function mapPolarSubscriptionStatus(
  eventType: string,
  data: Record<string, unknown>
): SubscriptionStatus {
  const knownStatuses = [
    "active",
    "canceled",
    "paused",
    "past_due",
    "incomplete",
    "trialing",
    "unpaid",
    "incomplete_expired",
  ]
  if (
    data.status != null &&
    (typeof data.status !== "string" || !knownStatuses.includes(data.status))
  ) {
    throw new Error("polar_subscription_status_invalid")
  }
  const status = (data.status ?? "active") as string
  if (status === "unpaid" || status === "incomplete_expired") return "canceled"

  switch (eventType) {
    case "subscription.revoked":
      return "canceled"
    case "subscription.uncanceled":
    case "subscription.resumed":
      return "active"
    case "subscription.active":
      return "active"
    case "subscription.paused":
      return "paused"
    case "subscription.past_due":
      return "past_due"
    case "subscription.canceled":
      return data.status === "active" ? "active" : "canceled"
    default:
      if (
        status === "active" ||
        status === "canceled" ||
        status === "paused" ||
        status === "past_due" ||
        status === "incomplete" ||
        status === "trialing"
      ) {
        return status as SubscriptionStatus
      }
      throw new Error("polar_subscription_status_invalid")
  }
}
