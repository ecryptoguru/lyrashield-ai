"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

interface AffiliateAdminActionsProps {
  affiliateId?: string
  payoutId?: string
  showSuspend?: boolean
  showTierOverride?: boolean
  showReactivate?: boolean
  showPayoutReconcile?: boolean
  showPayoutProfileVerification?: boolean
  currentProviderPayoutId?: string | null
  currentPayoutMethodVerified?: boolean
  currentTaxStatus?: "PENDING_REVIEW" | "VERIFIED" | "REJECTED" | "NOT_SUBMITTED"
  currentBaseRate?: number
  currentTierRate?: number
}

const BTN_GREEN =
  "rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
const BTN_RED =
  "rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
const BTN_SLATE =
  "rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"

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
  const [providerPayoutId, setProviderPayoutId] = useState(props.currentProviderPayoutId ?? "")
  const [providerStatus, setProviderStatus] = useState("processing")
  const [payoutMethodVerified, setPayoutMethodVerified] = useState(
    props.currentPayoutMethodVerified ?? false
  )
  const [taxStatus, setTaxStatus] = useState(
    props.currentTaxStatus === "VERIFIED" || props.currentTaxStatus === "REJECTED"
      ? props.currentTaxStatus
      : "PENDING_REVIEW"
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
              className={BTN_GREEN}
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
              className={BTN_RED}
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
            className={BTN_RED}
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
            className={BTN_GREEN}
          >
            Reactivate
          </button>
        )}
      </div>

      {props.showPayoutReconcile && props.payoutId && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            action(
              "reconcilePayout",
              {
                action: "reconcilePayout",
                payoutId: props.payoutId,
                providerPayoutId,
                providerStatus,
              },
              `Record provider state ${providerStatus} for this payout?`
            )
          }}
        >
          <label className="text-xs">
            Provider payout ID
            <input
              required
              maxLength={191}
              value={providerPayoutId}
              onChange={(event) => setProviderPayoutId(event.target.value)}
              className="mt-1 block w-48 rounded-md border px-2 py-1 text-xs"
            />
          </label>
          <label className="text-xs">
            Confirmed provider state
            <select
              value={providerStatus}
              onChange={(event) => setProviderStatus(event.target.value)}
              className="mt-1 block rounded-md border px-2 py-1 text-xs"
            >
              <option value="processing">Processing</option>
              <option value="processed">Processed</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          <button type="submit" disabled={loading === "reconcilePayout"} className={BTN_SLATE}>
            Record reconciliation
          </button>
        </form>
      )}

      {props.showPayoutProfileVerification && props.affiliateId && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            action(
              "verifyPayoutProfile",
              {
                action: "verifyPayoutProfile",
                affiliateId: props.affiliateId,
                payoutMethodVerified,
                taxStatus,
              },
              "Record this operator review?"
            )
          }}
        >
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={payoutMethodVerified}
              onChange={(event) => setPayoutMethodVerified(event.target.checked)}
            />
            Payout method verified
          </label>
          <label className="text-xs">
            Tax review
            <select
              value={taxStatus}
              onChange={(event) =>
                setTaxStatus(event.target.value as "PENDING_REVIEW" | "VERIFIED" | "REJECTED")
              }
              className="mt-1 block rounded-md border px-2 py-1 text-xs"
            >
              <option value="PENDING_REVIEW">Pending review</option>
              <option value="VERIFIED">Verified</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </label>
          <button type="submit" disabled={loading === "verifyPayoutProfile"} className={BTN_SLATE}>
            Save verification
          </button>
        </form>
      )}

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
          <button type="submit" disabled={loading === "tierOverride"} className={BTN_SLATE}>
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
