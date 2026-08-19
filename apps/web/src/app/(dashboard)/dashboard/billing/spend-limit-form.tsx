"use client"

import { useState } from "react"
import { buttonVariants } from "@lyrashield/ui"
import { useRouter } from "next/navigation"

interface SpendLimitFormProps {
  workspaceId: string
  currentCents: number | null
}

/**
 * Team-only overage spend-limit editor. Posts integer cents to
 * POST /api/billing/spend-limit?workspaceId=… — the API already exists
 * this form was the missing client.
 */
export function SpendLimitForm({ workspaceId, currentCents }: SpendLimitFormProps) {
  const router = useRouter()
  const [dollars, setDollars] = useState(
    currentCents != null ? (currentCents / 100).toFixed(2) : ""
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSaved(false)
    const parsed = Number.parseFloat(dollars)
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError("Enter a non-negative dollar amount.")
      setLoading(false)
      return
    }
    const cents = Math.round(parsed * 100)
    try {
      const res = await fetch(
        `/api/billing/spend-limit?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cents }),
        }
      )
      const data = (await res.json()) as { success?: boolean; error?: { message?: string } }
      if (!res.ok || !data.success) {
        setError(data.error?.message ?? "Could not update the spend limit.")
        return
      }
      setSaved(true)
      router.refresh()
    } catch {
      setError("Could not update the spend limit.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <label className="block text-sm font-medium" htmlFor="spend-limit-dollars">
        Monthly overage cap (USD)
      </label>
      <div className="flex items-center gap-2">
        <input
          id="spend-limit-dollars"
          type="number"
          min="0"
          step="0.01"
          value={dollars}
          onChange={(e) => {
            setDollars(e.target.value)
            setSaved(false)
          }}
          className="w-40 rounded-md border px-3 py-2 text-sm"
          placeholder="0.00"
        />
        <button
          type="submit"
          disabled={loading}
          className={buttonVariants({ variant: "default", size: "sm" })}
        >
          {loading ? "Saving…" : "Save limit"}
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="text-sm text-green-700" role="status">
          Spend limit updated.
        </p>
      )}
    </form>
  )
}
