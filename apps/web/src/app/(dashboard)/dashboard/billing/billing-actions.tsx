"use client"

import { useState } from "react"
import { buttonVariants } from "@lyrashield/ui"
import { useRouter } from "next/navigation"
import { openRazorpaySubscriptionCheckout } from "@/lib/razorpay-checkout"

interface BillingActionsProps {
  plan: string
  isTeam: boolean
  workspaceId: string
  purchasesAvailable: boolean
}

/**
 * Client-side billing action buttons.
 * Shows upgrade/downgrade, monthly↔annual toggle, and pack purchase links.
 * All actions POST via fetch() and redirect to the returned URL — never
 * linking directly to POST routes via GET (which would 405).
 * No $ cost values are displayed here per the billing design constraint.
 */
export function BillingActions({
  plan,
  isTeam: _isTeam,
  workspaceId,
  purchasesAvailable,
}: BillingActionsProps) {
  const router = useRouter()
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleCheckout(targetPlan: string, interval: string) {
    setLoading(`checkout-${targetPlan}`)
    setError(null)
    try {
      const res = await fetch("/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, plan: targetPlan, interval }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error?.message ?? "Unable to start checkout. Please try again.")
      } else if (data.success && data.data?.url) {
        window.location.href = data.data.url
      } else if (data.success && data.data?.subscriptionId && data.data?.keyId) {
        await openRazorpaySubscriptionCheckout({
          keyId: data.data.keyId,
          subscriptionId: data.data.subscriptionId,
          onAuthorized: () => router.push("/dashboard/billing?checkout=processing"),
          onDismiss: () => setLoading(null),
        })
      } else {
        setError("Unable to start checkout. Please try again.")
      }
    } catch {
      setError("Unable to start checkout. Check your connection and try again.")
    } finally {
      setLoading(null)
    }
  }

  if (plan === "FREE" || plan === "STARTER") {
    if (!purchasesAvailable) return null
    return (
      <div className="flex flex-col items-end gap-2">
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <button
          onClick={() => handleCheckout("PRO", "monthly")}
          disabled={loading === "checkout-PRO"}
          className={buttonVariants({ variant: "default", size: "sm" })}
        >
          {loading === "checkout-PRO" ? "Loading..." : "Upgrade"}
        </button>
      </div>
    )
  }

  if (plan === "PRO") {
    return (
      <div className="flex flex-col items-end gap-2">
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          {purchasesAvailable && (
            <button
              onClick={() => handleCheckout("TEAM", "monthly")}
              disabled={loading === "checkout-TEAM"}
              className={buttonVariants({ variant: "default", size: "sm" })}
            >
              {loading === "checkout-TEAM" ? "Loading..." : "Upgrade to Team"}
            </button>
          )}
          <a
            href={`/billing/portal?workspaceId=${encodeURIComponent(workspaceId)}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Manage
          </a>
        </div>
      </div>
    )
  }

  // Team plan
  return (
    <div className="flex gap-2">
      <a
        href={`/billing/portal?workspaceId=${encodeURIComponent(workspaceId)}`}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Manage Subscription
      </a>
    </div>
  )
}
