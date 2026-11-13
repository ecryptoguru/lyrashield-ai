"use client"

import { useRef, useState } from "react"
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
  const pending = useRef(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleBuy() {
    if (pending.current) return
    pending.current = true
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/billing/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, pack: packId }),
      })
      const data = await res.json()
      if (res.ok && data.success && data.data?.url) {
        window.location.assign(data.data.url)
        return
      } else {
        setError(data.error?.message ?? "Unable to start this purchase. Please try again.")
      }
    } catch {
      setError("Unable to start this purchase. Check your connection and try again.")
    }
    pending.current = false
    setLoading(false)
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={handleBuy}
        disabled={loading}
        className={`${buttonVariants({ variant: "outline" })} w-full`}
      >
        {loading ? "Opening secure checkout…" : "Buy Minute Pack"}
      </button>
    </div>
  )
}
