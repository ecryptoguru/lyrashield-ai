"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

interface AffiliateAdminActionsProps {
  affiliateId?: string
  payoutId?: string
  showSuspend?: boolean
  showTierOverride?: boolean
  showReactivate?: boolean
  showPayoutApprove?: boolean
  currentBaseRate?: number
  currentTierRate?: number
}

export function AffiliateAdminActions(props: AffiliateAdminActionsProps) {
  const router = useRouter()
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [baseRate, setBaseRate] = useState(
    props.currentBaseRate != null ? String(props.currentBaseRate) : "2500"
  )
  const [tierRate, setTierRate] = useState(
    props.currentTierRate != null ? String(props.currentTierRate) : "3000"
  )

  async function action(name: string, body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return
    setLoading(name)
    setError(null)
    setMessage(null)
    try {
      const res = await fetch("/api/admin/affiliates/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || data.success === false) {
        setError(typeof data.error === "string" ? data.error : "Action failed.")
        return
      }
      setMessage("Done.")
      router.refresh()
    } catch {
      setError("Action failed.")
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {props.affiliateId && !props.showSuspend && !props.showReactivate && (
          <>
            <button
              onClick={() =>
                action("approve", { action: "approve", affiliateId: props.affiliateId })
              }
              disabled={loading === "approve"}
              className={
            "rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          }
            >
              Approve
            </button>
            <button
              onClick={() =>
                action(
                  "reject",
                  { action: "reject", affiliateId: props.affiliateId },
                  "Reject this affiliate application? This cannot be undone from here."
                )
              }
              disabled={loading === "reject"}
              className={
                "rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
              }
            >
              Reject
            </button>
          </>
        )}

        {props.showSuspend && (
          <button
            onClick={() =>
              action(
                "suspend",
                { action: "suspend", affiliateId: props.affiliateId },
                "Suspend this affiliate? They will stop earning new commissions."
              )
            }
            disabled={loading === "suspend"}
            className={
            "rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          }
          >
            Suspend
          </button>
        )}

        {props.showReactivate && (
          <button
            onClick={() =>
              action("reactivate", { action: "approve", affiliateId: props.affiliateId })
            }
            disabled={loading === "reactivate"}
            className={
            "rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          }
          >
            Reactivate
          </button>
        )}

        {props.showPayoutApprove && (
          <button
            onClick={() =>
              action("approvePayout", { action: "approvePayout", payoutId: props.payoutId })
            }
            disabled={loading === "approvePayout"}
            className={
            "rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          }
          >
            Approve Payout
          </button>
        )}
      </div>

      {props.showTierOverride && props.affiliateId && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            action("tierOverride", {
              action: "tierOverride",
              affiliateId: props.affiliateId,
              baseRateBps: Number.parseInt(baseRate, 10),
              tierRateBps: Number.parseInt(tierRate, 10),
            })
          }}
        >
          <label className="text-xs">
            Base bps
            <input
              type="number"
              min={0}
              max={10000}
              value={baseRate}
              onChange={(e) => setBaseRate(e.target.value)}
              className="mt-1 block w-24 rounded-md border px-2 py-1 text-xs"
            />
          </label>
          <label className="text-xs">
            Tier bps
            <input
              type="number"
              min={0}
              max={10000}
              value={tierRate}
              onChange={(e) => setTierRate(e.target.value)}
              className="mt-1 block w-24 rounded-md border px-2 py-1 text-xs"
            />
          </label>
          <button
            type="submit"
            disabled={loading === "tierOverride"}
            className={
            "rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          }
          >
            Save rates
          </button>
        </form>
      )}

      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="text-xs text-green-700" role="status">
          {message}
        </p>
      )}
    </div>
  )
}
