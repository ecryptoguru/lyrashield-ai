"use client"

import { useState } from "react"
import { buttonVariants } from "@lyrashield/ui"
import { TrendingUp } from "lucide-react"
import { useRouter } from "next/navigation"

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

  async function handleUpgrade() {
    setLoading(true)
    try {
      const res = await fetch("/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, plan: "PRO", interval: "monthly" }),
      })
      const data = await res.json()
      if (data.success && data.data?.url) {
        window.location.href = data.data.url
      } else if (data.success && data.data?.subscriptionId) {
        router.push("/dashboard/billing?subscription=" + data.data.subscriptionId)
      } else {
        console.error("Upgrade failed", data)
      }
    } catch (err) {
      console.error("Upgrade request failed", err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleUpgrade}
      disabled={loading}
      className={`${buttonVariants({ variant: "default" })} w-full`}
    >
      <TrendingUp className="mr-2 h-4 w-4" />
      {loading ? "Loading..." : "Upgrade Now"}
    </button>
  )
}
