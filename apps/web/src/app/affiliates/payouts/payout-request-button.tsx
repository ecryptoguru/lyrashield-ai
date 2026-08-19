"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

interface PayoutRequestButtonProps {
  eligible: boolean
  reasons: string[]
  availableAmount: string
  affiliateId: string
}

export function PayoutRequestButton({
  eligible,
  reasons,
  availableAmount,
  affiliateId,
}: PayoutRequestButtonProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRequest() {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch("/affiliates/api/payouts/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ affiliateId }),
      })

      const data = await response.json()

      if (response.ok && data.success) {
        router.refresh()
      } else {
        setError(data.error ?? "Payout request failed")
      }
    } catch {
      setError("Network error")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleRequest}
        disabled={!eligible || loading}
        className="rounded-lg bg-primary px-6 py-2.5 text-primary-foreground font-semibold disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Processing..." : "Request Payout"}
      </button>

      <div className="mt-2 text-sm">
        <span className="text-muted-foreground">Available: </span>
        <span className="font-medium">${Number(availableAmount).toFixed(2)}</span>
      </div>

      {!eligible && reasons.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          {reasons.map((reason, i) => (
            <li key={i}>• {reason}</li>
          ))}
        </ul>
      )}

      {error && (
        <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  )
}
