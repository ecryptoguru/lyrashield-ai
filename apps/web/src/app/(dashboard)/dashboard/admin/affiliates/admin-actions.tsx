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

  async function action(name: string, body: Record<string, unknown>) {
    setLoading(name)
    try {
      await fetch("/api/admin/affiliates/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      router.refresh()
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="flex gap-2">
      {props.affiliateId && !props.showSuspend && !props.showReactivate && (
        <>
          <button
            onClick={() => action("approve", { action: "approve", affiliateId: props.affiliateId })}
            disabled={loading === "approve"}
            className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={() => action("reject", { action: "reject", affiliateId: props.affiliateId })}
            disabled={loading === "reject"}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            Reject
          </button>
        </>
      )}

      {props.showSuspend && (
        <button
          onClick={() => action("suspend", { action: "suspend", affiliateId: props.affiliateId })}
          disabled={loading === "suspend"}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
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
          className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
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
          className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          Approve Payout
        </button>
      )}
    </div>
  )
}
