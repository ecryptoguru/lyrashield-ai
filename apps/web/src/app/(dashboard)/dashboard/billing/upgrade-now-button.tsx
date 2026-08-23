"use client"

import { useState } from "react"
import { buttonVariants } from "@lyrashield/ui"
import { TrendingUp } from "lucide-react"
import { useRouter } from "next/navigation"
import { openRazorpaySubscriptionCheckout } from "@/lib/razorpay-checkout"

interface UpgradeNowButtonProps {
  workspaceId: string
}

/**
 * Client-side "Upgrade Now" button for the trial status card.
 * POSTs to /billing/checkout and redirects to the returned URL.
 */
export function UpgradeNowButton({ workspaceId }: UpgradeNowButtonProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleUpgrade() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, plan: "PRO", interval: "monthly" }),
      })
      const data = await res.json()
      if (data.success && data.data?.url) {
        window.location.href = data.data.url
      } else if (data.success && data.data?.subscriptionId && data.data?.keyId) {
        await openRazorpaySubscriptionCheckout({
          keyId: data.data.keyId,
          subscriptionId: data.data.subscriptionId,
          onAuthorized: () => router.push("/dashboard/billing?checkout=processing"),
        })
      } else {
        setError(data.error?.message ?? "Unable to start checkout. Please try again.")
      }
    } catch {
      setError("Unable to start checkout. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <button
        onClick={handleUpgrade}
        disabled={loading}
        className={`${buttonVariants({ variant: "default" })} w-full`}
      >
        <TrendingUp className="mr-2 h-4 w-4" />
        {loading ? "Loading..." : "Upgrade Now"}
      </button>
    </div>
  )
}
