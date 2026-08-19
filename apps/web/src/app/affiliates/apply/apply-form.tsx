"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

interface ApplyFormProps {
  userId: string
}

/**
 * Client apply form. The previous native POST dumped the JSON body into the
 * document (`{success:true}`) and wiped the fields on any error. This keeps
 * entered values, shows a field-preserving error and a Submitted state.
 */
export function AffiliateApplyForm({ userId }: ApplyFormProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [values, setValues] = useState({
    name: "",
    website: "",
    audienceSize: "",
    audienceType: "",
    promotionMethods: "",
    payoutMethod: "",
    taxFormStatus: "",
    acceptTerms: false,
  })

  function set<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const body = new FormData()
    body.set("userId", userId)
    body.set("name", values.name)
    body.set("website", values.website)
    body.set("audienceSize", values.audienceSize)
    body.set("audienceType", values.audienceType)
    body.set("promotionMethods", values.promotionMethods)
    body.set("payoutMethod", values.payoutMethod)
    body.set("taxFormStatus", values.taxFormStatus)
    if (values.acceptTerms) body.set("acceptTerms", "true")

    try {
      const res = await fetch("/affiliates/api/apply", { method: "POST", body })
      const data = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || !data.success) {
        setError(typeof data.error === "string" ? data.error : "Could not submit the application.")
        return
      }
      setSubmitted(true)
      router.refresh()
    } catch {
      setError("Could not submit the application.")
    } finally {
      setLoading(false)
    }
  }

  if (submitted) {
    return (
      <div className="rounded-lg border p-6">
        <h2 className="text-xl font-semibold">Application submitted</h2>
        <p className="mt-2 text-muted-foreground">
          Your affiliate application is pending review. We will email you when it is decided.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <div>
        <label htmlFor="name" className="block text-sm font-medium">
          Your Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={100}
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          className="mt-1 block w-full rounded-md border px-3 py-2"
          placeholder="Jane Doe"
        />
      </div>

      <div>
        <label htmlFor="website" className="block text-sm font-medium">
          Website / Channel URL
        </label>
        <input
          id="website"
          name="website"
          type="url"
          required
          maxLength={500}
          value={values.website}
          onChange={(e) => set("website", e.target.value)}
          className="mt-1 block w-full rounded-md border px-3 py-2"
          placeholder="https://yourblog.com"
        />
      </div>

      <div>
        <label htmlFor="audienceSize" className="block text-sm font-medium">
          Audience Size
        </label>
        <select
          id="audienceSize"
          name="audienceSize"
          required
          value={values.audienceSize}
          onChange={(e) => set("audienceSize", e.target.value)}
          className="mt-1 block w-full rounded-md border px-3 py-2"
        >
          <option value="">Select...</option>
          <option value="<1k">&lt; 1,000</option>
          <option value="1k-10k">1,000 – 10,000</option>
          <option value="10k-50k">10,000 – 50,000</option>
          <option value="50k-100k">50,000 – 100,000</option>
          <option value="100k+">100,000+</option>
        </select>
      </div>

      <div>
        <label htmlFor="audienceType" className="block text-sm font-medium">
          Audience Type
        </label>
        <select
          id="audienceType"
          name="audienceType"
          required
          value={values.audienceType}
          onChange={(e) => set("audienceType", e.target.value)}
          className="mt-1 block w-full rounded-md border px-3 py-2"
        >
          <option value="">Select...</option>
          <option value="developers">Developers / Engineers</option>
          <option value="security">Security Professionals</option>
          <option value="devops">DevOps / SRE</option>
          <option value="founders">Founders / Executives</option>
          <option value="mixed">Mixed Technical</option>
        </select>
      </div>

      <div>
        <label htmlFor="promotionMethods" className="block text-sm font-medium">
          Promotion Methods
        </label>
        <textarea
          id="promotionMethods"
          name="promotionMethods"
          required
          maxLength={2000}
          rows={4}
          value={values.promotionMethods}
          onChange={(e) => set("promotionMethods", e.target.value)}
          className="mt-1 block w-full rounded-md border px-3 py-2"
          placeholder="Blog posts, YouTube videos, newsletters, conference talks, etc."
        />
      </div>

      <div>
        <label htmlFor="payoutMethod" className="block text-sm font-medium">
          Preferred Payout Method
        </label>
        <select
          id="payoutMethod"
          name="payoutMethod"
          required
          value={values.payoutMethod}
          onChange={(e) => set("payoutMethod", e.target.value)}
          className="mt-1 block w-full rounded-md border px-3 py-2"
        >
          <option value="">Select...</option>
          <option value="razorpayx">RazorpayX (India — INR)</option>
          <option value="payoneer">Payoneer (Global)</option>
          <option value="briskpe">BriskPe (RBI-native fallback)</option>
        </select>
      </div>

      <div>
        <label htmlFor="taxFormStatus" className="block text-sm font-medium">
          Tax Form Status
        </label>
        <select
          id="taxFormStatus"
          name="taxFormStatus"
          required
          value={values.taxFormStatus}
          onChange={(e) => set("taxFormStatus", e.target.value)}
          className="mt-1 block w-full rounded-md border px-3 py-2"
        >
          <option value="">Select...</option>
          <option value="will_complete">Will complete W-9/W-8BEN/W-8BEN-E/GSTIN</option>
          <option value="have_w9">Have W-9 on file</option>
          <option value="have_w8ben">Have W-8BEN on file</option>
          <option value="have_w8ben_e">Have W-8BEN-E on file</option>
          <option value="have_gstin">Have GSTIN on file (India)</option>
        </select>
      </div>

      <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/50">
        <h3 className="font-medium text-gray-900 dark:text-white">Affiliate Program Terms</h3>
        <ul className="mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-400">
          <li>
            • <strong>Disclosure:</strong> You must clearly disclose your affiliate relationship
            in every promotion, following FTC (US) and ASA (UK) affiliate-disclosure rules.
          </li>
          <li>
            • <strong>Honest claims only:</strong> No fear-mongering (FUD), no &ldquo;only
            we&rdquo; / exclusivity claims, and no benchmark, accuracy, false-positive-rate or
            coverage comparisons.
          </li>
          <li>
            • <strong>No brand bidding:</strong> Do not bid on the brand name
            &ldquo;LyraShield&rdquo; in search ads. Zero tolerance.
          </li>
          <li>
            • <strong>No self-referrals:</strong> No commission on your own signups, trial
            conversions or one-time minute packs.
          </li>
          <li>
            • <strong>No upstream naming:</strong> Do not name the underlying scan-engine project.
            Refer to the product as LyraShield only.
          </li>
        </ul>
        <label className="mt-3 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            id="acceptTerms"
            name="acceptTerms"
            checked={values.acceptTerms}
            onChange={(e) => set("acceptTerms", e.target.checked)}
            required
            className="mt-1 h-4 w-4 rounded border-gray-300"
          />
          <span>
            I have read and accept the LyraShield Affiliate Program Terms, including the FTC/ASA
            disclosure obligation, the honest-claims and no-FUD rules, the no-brand-bidding clause
            and the no-self-referral rule.
          </span>
        </label>
      </div>

      <button
        type="submit"
        disabled={loading}
        className={
          "w-full rounded-lg bg-primary px-6 py-3 font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        }
      >
        {loading ? "Submitting…" : "Submit Application"}
      </button>
    </form>
  )
}
 </button>
    </form>
  )
}
 </form>
  )
}
