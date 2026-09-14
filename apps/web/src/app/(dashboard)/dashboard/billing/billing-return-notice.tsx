"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, RefreshCw } from "lucide-react"
import { buttonVariants } from "@lyrashield/ui"
import { track } from "@/lib/analytics"

export function BillingReturnNotice({
  checkout,
  topup,
  provider,
  plan,
  trialActive,
}: {
  checkout?: string
  topup?: string
  provider: "polar" | "razorpay"
  plan: string
  trialActive: boolean
}) {
  const router = useRouter()

  // This component mounts on every billing page render (it returns null when
  // there is no return state), so it owns the page-level funnel events:
  // billing_opened always; checkout_completed on a provider return. The
  // entitlement itself lands only via the signed webhook — the event records
  // the user's return, never a billing fact.
  useEffect(() => {
    track("billing_opened", { plan, trial_active: trialActive })
    if (checkout === "success" || checkout === "processing") {
      track("checkout_completed", { provider, outcome: checkout })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (![checkout, topup].some((value) => value === "success" || value === "processing")) return null

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
          <p className="font-medium">Payment submitted; provider confirmation is processing.</p>
          <p>Checkout rail: {rail}. Your entitlement updates only after a signed webhook.</p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => router.refresh()}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
        Refresh billing status
      </button>
    </div>
  )
}
