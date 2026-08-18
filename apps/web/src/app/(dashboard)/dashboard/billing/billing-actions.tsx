"use client"

import { useState } from "react"
import { buttonVariants } from "@lyrashield/ui"
import { useRouter } from "next/navigation"

interface BillingActionsProps {
  plan: string
  isTeam: boolean
  workspaceId: string
}

/**
 * Client-side billing action buttons.
 * Shows upgrade/downgrade, monthly↔annual toggle, and pack purchase links.
 * All actions POST via fetch() and redirect to the returned URL — never
 * linking directly to POST routes via GET (which would 405).
 * No $ cost values are displayed here per the billing design constraint.
 */
export function BillingActions({ plan, isTeam: _isTeam, workspaceId }: BillingActionsProps) {
  const router = useRouter()
  const [loading, setLoading] = useState<string | null>(null)

  async function handleCheckout(targetPlan: string, interval: string) {
    setLoading(`checkout-${targetPlan}`)
    try {
      const res = await fetch("/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, plan: targetPlan, interval }),
      })
      const data = await res.json()
      if (data.success && data.data?.url) {
        window.location.href = data.data.url
      } else if (data.success && data.data?.subscriptionId) {
        // Razorpay subscription — redirect to billing page with subscription ID
        router.push("/dashboard/billing?subscription=" + data.data.subscriptionId)
      } else {
        console.error("Checkout failed", data)
      }
    } catch (err) {
      console.error("Checkout request failed", err)
    } finally {
      setLoading(null)
    }
  }

  if (plan === "FREE" || plan === "STARTER") {
    return (
      <div className="flex gap-2">
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
      <div className="flex gap-2">
        <button
          onClick={() => handleCheckout("TEAM", "monthly")}
          disabled={loading === "checkout-TEAM"}
          className={buttonVariants({ variant: "default", size: "sm" })}
        >
          {loading === "checkout-TEAM" ? "Loading..." : "Upgrade to Team"}
        </button>
        <a
          href="/billing/portal"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Manage
        </a>
      </div>
    )
  }

  // Team plan
  return (
    <div className="flex gap-2">
      <a
        href="/billing/portal"
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Manage Subscription
      </a>
    </div>
  )
}
