import Link from "next/link"
import { redirect } from "next/navigation"
import { getCachedSession } from "@/lib/cache"
import { prisma } from "@lyrashield/db"

export const metadata = {
  title: "Apply — Affiliate Program — LyraShield AI",
}

export default async function AffiliateApplyPage() {
  const session = await getCachedSession()
  if (!session) {
    redirect("/sign-in?callbackURL=/affiliates/apply")
  }

  // Check if already applied
  const existing = await prisma.affiliate.findUnique({
    where: { userId: session.userId },
    select: { id: true, status: true },
  })

  if (existing) {
    if (existing.status === "APPROVED") {
      redirect("/affiliates/dashboard")
    }
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <h1 className="text-2xl font-bold">Application Submitted</h1>
        <p className="mt-4 text-muted-foreground">
          Your affiliate application is currently{" "}
          <span className="font-semibold">{existing.status}</span>. Our team will review it and
          notify you of the decision.
        </p>
        <Link href="/" className="mt-6 inline-block text-primary hover:underline">
          Back to home
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="mb-2 text-3xl font-bold">Affiliate Application</h1>
      <p className="mb-8 text-muted-foreground">
        Tell us about your audience and how you plan to promote LyraShield AI.
      </p>

      <form action="/affiliates/api/apply" method="POST" className="space-y-6">
        <input type="hidden" name="userId" value={session.userId} />

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

        {/* C-L10: Binding program terms acceptance */}
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
              value="true"
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
          className="w-full rounded-lg bg-primary px-6 py-3 text-primary-foreground font-semibold hover:bg-primary/90"
        >
          Submit Application
        </button>
      </form>
    </div>
  )
}
