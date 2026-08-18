"use client"

import { useState } from "react"
import { buttonVariants } from "@lyrashield/ui"

interface BuyPackButtonProps {
  workspaceId: string
  packId?: "pack_100" | "pack_250" | "pack_500"
}

/**
 * Client-side "Buy Minute Pack" button.
 * POSTs to /api/billing/topup and redirects to the returned checkout URL.
 * Never links directly to a POST route via GET.
 */
export function BuyPackButton({ workspaceId, packId = "pack_100" }: BuyPackButtonProps) {
  const [loading, setLoading] = useState(false)

  async function handleBuy() {
    setLoading(true)
    try {
      const res = await fetch("/api/billing/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, pack: packId }),
      })
      const data = await res.json()
      if (data.success && data.data?.url) {
        window.location.href = data.data.url
      } else {
        console.error("Top-up failed", data)
      }
    } catch (err) {
      console.error("Top-up request failed", err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleBuy}
      disabled={loading}
      className={`${buttonVariants({ variant: "outline" })} w-full`}
    >
      {loading ? "Loading..." : "Buy Minute Pack"}
    </button>
  )
}
