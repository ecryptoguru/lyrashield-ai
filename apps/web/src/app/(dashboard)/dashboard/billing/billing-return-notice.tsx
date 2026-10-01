"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, RefreshCw } from "lucide-react"
import { buttonVariants } from "@lyrashield/ui"
import { track } from "@/lib/analytics"
import {
  parseProviderReturnOutcome,
  resolveBillingReturnState,
  startBoundedProviderReturnRefresh,
} from "@/lib/billing-return-state"

export function BillingReturnNotice({
  checkout,
  topup,
  provider,
  plan,
  planName,
  trialActive,
  accountHasPaidPlan,
}: {
  checkout?: string
  topup?: string
  provider: "polar" | "razorpay"
  plan: string
  planName: string
  trialActive: boolean
  accountHasPaidPlan: boolean
}) {
  const router = useRouter()
  const [stillProcessing, setStillProcessing] = useState(false)
  const state = resolveBillingReturnState({ checkout, topup, accountHasPaidPlan })
  const accountIsCurrent = state.kind === "account-current"

  // This component mounts on every billing page render (it returns null when
  // there is no return state), so it owns the page-level funnel event. A
  // checkout return records only the browser's return from the provider; it
  // does not establish payment or entitlement.
  useEffect(() => {
    track("billing_opened", { plan, trial_active: trialActive })
    if (parseProviderReturnOutcome(checkout)) {
      track("checkout_returned", { provider, outcome: checkout })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!state.shouldRefresh) return
    return startBoundedProviderReturnRefresh({
      refresh: () => router.refresh(),
      isResolved: () => accountIsCurrent,
      onExhausted: () => setStillProcessing(true),
    })
  }, [accountIsCurrent, router, state.kind, state.shouldRefresh])

  if (state.kind === "none") return null

  const rail = provider === "razorpay" ? "Razorpay in INR" : "Polar in USD"
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-3 rounded-md border border-blue-300 bg-blue-50 p-4 text-sm text-blue-950 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          {state.kind === "cancelled" ? (
            <>
              <p className="font-medium">The provider returned a cancelled checkout status.</p>
              <p>Your current account state remains authoritative.</p>
            </>
          ) : state.kind === "account-current" ? (
            <>
              <p className="font-medium">Your account currently shows {planName} access.</p>
              <p>
                This page does not confirm settlement of a specific payment. Checkout rail: {rail}.
              </p>
            </>
          ) : state.kind === "topup-pending" ? (
            <>
              <p className="font-medium">
                {stillProcessing
                  ? "Still processing; check again."
                  : "Minute-pack confirmation is still processing."}
              </p>
              <p>
                The balance below comes from your account records. A provider return does not
                confirm a top-up.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">
                {stillProcessing
                  ? "Still processing; check again."
                  : "Provider confirmation is still processing."}
              </p>
              <p>
                Your account updates only after an authoritative billing event. A return URL does
                not grant plan access. Checkout rail: {rail}.
              </p>
            </>
          )}
        </div>
      </div>
      {state.kind !== "cancelled" && (
        <button
          type="button"
          onClick={() => router.refresh()}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          {stillProcessing ? "Still processing; check again" : "Refresh billing status"}
        </button>
      )}
    </div>
  )
}
