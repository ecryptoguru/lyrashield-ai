export type ProviderReturnOutcome = "success" | "processing" | "cancelled"
export type BillingReturnState =
  | { kind: "none"; shouldRefresh: false }
  | { kind: "cancelled"; shouldRefresh: false }
  | { kind: "checkout-pending"; shouldRefresh: true }
  | { kind: "topup-pending"; shouldRefresh: true }
  | { kind: "account-current"; shouldRefresh: false }

export const MAX_PROVIDER_RETURN_REFRESHES = 3
const PROVIDER_RETURN_REFRESH_INTERVAL_MS = 2_000

export function parseProviderReturnOutcome(
  value: string | undefined
): ProviderReturnOutcome | null {
  return value === "success" || value === "processing" || value === "cancelled" ? value : null
}

export function resolveBillingReturnState(input: {
  checkout?: string
  topup?: string
  accountHasPaidPlan: boolean
}): BillingReturnState {
  const checkout = parseProviderReturnOutcome(input.checkout)
  const topup = parseProviderReturnOutcome(input.topup)
  if (checkout === "cancelled" || topup === "cancelled") {
    return { kind: "cancelled", shouldRefresh: false }
  }
  if (topup) return { kind: "topup-pending", shouldRefresh: true }
  if (checkout && input.accountHasPaidPlan) return { kind: "account-current", shouldRefresh: false }
  if (checkout) return { kind: "checkout-pending", shouldRefresh: true }
  return { kind: "none", shouldRefresh: false }
}

/** Refresh only server-owned billing state, then stop after three attempts. */
export function startBoundedProviderReturnRefresh(input: {
  refresh: () => void
  isResolved: () => boolean
  onExhausted: () => void
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}): () => void {
  const schedule = input.schedule ?? setTimeout
  const cancel = input.cancel ?? clearTimeout
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const check = () => {
    if (stopped || input.isResolved()) return
    if (attempts >= MAX_PROVIDER_RETURN_REFRESHES) {
      timer = schedule(() => {
        timer = undefined
        if (!stopped && !input.isResolved()) input.onExhausted()
      }, PROVIDER_RETURN_REFRESH_INTERVAL_MS)
      return
    }
    timer = schedule(() => {
      timer = undefined
      if (stopped || input.isResolved()) return
      attempts += 1
      input.refresh()
      check()
    }, PROVIDER_RETURN_REFRESH_INTERVAL_MS)
  }

  check()
  return () => {
    stopped = true
    if (timer !== undefined) cancel(timer)
  }
}
