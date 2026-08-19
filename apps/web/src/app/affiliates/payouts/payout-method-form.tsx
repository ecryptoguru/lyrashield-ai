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
  const [taxFormType, setTaxFormType] = useState((currentMethod?.taxFormType as string) ?? "")
  const [loading, setLoading] = useState(false)
  const [saved, setSaved] = useState(false)

  // Provider-specific fields
  const [accountNumber, setAccountNumber] = useState("")
  const [ifsc, setIfsc] = useState("")
  const [upiId, setUpiId] = useState("")
  const [beneficiaryName, setBeneficiaryName] = useState("")
  const [payeeEmail, setPayeeEmail] = useState("")
  const [country, setCountry] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setSaved(false)

    const methodData: Record<string, unknown> = {
      type,
      // C-L10: Don't send valid: true from the client — the server is the
      // sole setter of the valid flag (always false until admin verifies).
      taxFormType,
    }

    if (type === "razorpayx") {
      methodData.accountNumber = accountNumber
      methodData.ifsc = ifsc
      methodData.upiId = upiId
      methodData.beneficiaryName = beneficiaryName
    } else if (type === "payoneer") {
      methodData.email = payeeEmail
      methodData.country = country
    } else if (type === "briskpe") {
      methodData.accountNumber = accountNumber
      methodData.ifsc = ifsc
      methodData.beneficiaryName = beneficiaryName
      methodData.country = country
    }

    try {
      await fetch("/affiliates/api/payouts/method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ affiliateId, payoutMethod: methodData }),
      })
      setSaved(true)
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium">Payout Method</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          required
          className="mt-1 block w-full rounded-md border px-3 py-2"
        >
          <option value="">Select...</option>
          <option value="razorpayx">RazorpayX (India — INR)</option>
          <option value="payoneer">Payoneer (Global)</option>
          <option value="briskpe">BriskPe (RBI-native fallback)</option>
        </select>
      </div>

      {type === "razorpayx" && (
        <>
          <div>
            <label className="block text-sm font-medium">Beneficiary Name</label>
            <input
              type="text"
              value={beneficiaryName}
              onChange={(e) => setBeneficiaryName(e.target.value)}
              required
              maxLength={100}
              className="mt-1 block w-full rounded-md border px-3 py-2"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium">Account Number</label>
              <input
                type="text"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                required
                maxLength={50}
                className="mt-1 block w-full rounded-md border px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium">IFSC Code</label>
              <input
                type="text"
                value={ifsc}
                onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                required
                maxLength={11}
                pattern="[A-Z]{4}0[A-Z0-9]{6}"
                className="mt-1 block w-full rounded-md border px-3 py-2"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium">UPI ID (optional, for UPI payouts)</label>
            <input
              type="text"
              value={upiId}
              onChange={(e) => setUpiId(e.target.value)}
              maxLength={100}
              className="mt-1 block w-full rounded-md border px-3 py-2"
            />
          </div>
        </>
      )}

      {type === "payoneer" && (
        <>
          <div>
            <label className="block text-sm font-medium">Payoneer Email</label>
            <input
              type="email"
              value={payeeEmail}
              onChange={(e) => setPayeeEmail(e.target.value)}
              required
              maxLength={200}
              className="mt-1 block w-full rounded-md border px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Country</label>
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              required
              maxLength={2}
              placeholder="US, IN, GB..."
              className="mt-1 block w-full rounded-md border px-3 py-2"
            />
          </div>
        </>
      )}

      {type === "briskpe" && (
        <>
          <div>
            <label className="block text-sm font-medium">Beneficiary Name</label>
            <input
              type="text"
              value={beneficiaryName}
              onChange={(e) => setBeneficiaryName(e.target.value)}
              required
              maxLength={100}
              className="mt-1 block w-full rounded-md border px-3 py-2"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium">Account Number</label>
              <input
                type="text"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                required
                maxLength={50}
                className="mt-1 block w-full rounded-md border px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium">IFSC Code</label>
              <input
                type="text"
                value={ifsc}
                onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                required
                maxLength={11}
                className="mt-1 block w-full rounded-md border px-3 py-2"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium">Country</label>
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              required
              maxLength={2}
              className="mt-1 block w-full rounded-md border px-3 py-2"
            />
          </div>
        </>
      )}

      <div>
        <label className="block text-sm font-medium">Tax Form</label>
        <select
          value={taxFormType}
          onChange={(e) => setTaxFormType(e.target.value)}
          required
          className="mt-1 block w-full rounded-md border px-3 py-2"
        >
          <option value="">Select tax form...</option>
          <option value="W-9">W-9 (US residents)</option>
          <option value="W-8BEN">W-8BEN (individual non-US)</option>
          <option value="W-8BEN-E">W-8BEN-E (entity non-US)</option>
        </select>
      </div>

      <button
        type="submit"
        disabled={loading || !type || !taxFormType}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {loading ? "Saving..." : "Save Payout Method"}
      </button>

      {saved && <span className="ml-3 text-sm text-green-600">Saved!</span>}
    </form>
  )
}
