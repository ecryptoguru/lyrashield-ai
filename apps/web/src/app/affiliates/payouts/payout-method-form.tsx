"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

interface PayoutMethodFormProps {
  affiliateId: string
  currentMethod: Record<string, unknown> | null
}

export function PayoutMethodForm({ affiliateId, currentMethod }: PayoutMethodFormProps) {
  const router = useRouter()
  const [type, setType] = useState((currentMethod?.type as string) ?? "")
  const [providerRecipientId, setProviderRecipientId] = useState("")
  const [maskedDisplay, setMaskedDisplay] = useState("")
  const [taxFormType, setTaxFormType] = useState("")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    setMessage(null)
    setFailed(false)
    const payoutMethod =
      type === "razorpayx"
        ? { type, fundAccountId: providerRecipientId, maskedDisplay }
        : { type, payeeId: providerRecipientId, maskedDisplay }
    try {
      const response = await fetch("/affiliates/api/payouts/method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ affiliateId, payoutMethod, taxFormType }),
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) {
        setFailed(true)
        setMessage(body.error ?? "Payout method could not be saved.")
        return
      }
      setMessage("Saved for operator verification.")
      router.refresh()
    } catch {
      setFailed(true)
      setMessage("Payout method could not be saved. Check your connection and try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="payout-provider" className="block text-sm font-medium">
          Payout provider
        </label>
        <select
          id="payout-provider"
          value={type}
          onChange={(event) => setType(event.target.value)}
          required
          className="mt-1 block w-full rounded-md border px-3 py-2"
        >
          <option value="">Select…</option>
          <option value="razorpayx">RazorpayX hosted recipient (India)</option>
          <option value="payoneer" disabled>
            Payoneer (not yet available)
          </option>
        </select>
      </div>
      <div>
        <label htmlFor="provider-recipient" className="block text-sm font-medium">
          {type === "razorpayx" ? "RazorpayX fund account ID" : "Provider recipient ID"}
        </label>
        <input
          id="provider-recipient"
          value={providerRecipientId}
          onChange={(event) => setProviderRecipientId(event.target.value)}
          required
          maxLength={128}
          placeholder={type === "razorpayx" ? "fa_…" : "Provider-hosted ID"}
          className="mt-1 block w-full rounded-md border px-3 py-2"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Use the ID from provider-hosted onboarding. Do not enter a bank account number.
        </p>
      </div>
      <div>
        <label htmlFor="masked-display" className="block text-sm font-medium">
          Masked payout destination
        </label>
        <input
          id="masked-display"
          value={maskedDisplay}
          onChange={(event) => setMaskedDisplay(event.target.value)}
          required
          maxLength={64}
          placeholder="Bank •••• 4242"
          className="mt-1 block w-full rounded-md border px-3 py-2"
        />
      </div>
      <div>
        <label htmlFor="tax-form-type" className="block text-sm font-medium">
          Tax form type
        </label>
        <select
          id="tax-form-type"
          value={taxFormType}
          onChange={(event) => setTaxFormType(event.target.value)}
          required
          className="mt-1 block w-full rounded-md border px-3 py-2"
        >
          <option value="">Select…</option>
          <option value="w9">W-9</option>
          <option value="w8ben">W-8BEN</option>
          <option value="w8ben_e">W-8BEN-E</option>
          <option value="gstin">GSTIN</option>
        </select>
      </div>
      <button
        type="submit"
        disabled={loading || !type || !taxFormType}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {loading ? "Saving…" : "Save for verification"}
      </button>
      {message && (
        <p role={failed ? "alert" : "status"} className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </form>
  )
}
