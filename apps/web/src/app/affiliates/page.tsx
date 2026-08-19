import Link from "next/link"
import { loadActiveProgram } from "@lyrashield/affiliate"

export const metadata = {
  title: "Affiliate Program — LyraShield AI",
  description:
    "Earn recurring commissions by referring customers to LyraShield AI. 25% recurring, 30% at 10+ active referrals, 20% on Local licenses.",
}

export default async function AffiliateLandingPage() {
  let terms: {
    baseRateBps: number
    tierRateBps: number
    tierThreshold: number
    capMonths: number
    holdDays: number
    minPayout: string
    reservePct: number
    reserveDays: number
  } | null = null

  try {
    const program = await loadActiveProgram()
    terms = {
      baseRateBps: program.baseRateBps,
      tierRateBps: program.tierRateBps,
      tierThreshold: program.tierThreshold,
      capMonths: program.capMonths,
      holdDays: program.holdDays,
      minPayout: program.minPayout,
      reservePct: program.reservePct,
      reserveDays: program.reserveDays,
    }
  } catch {
    // No active program — use defaults
    terms = {
      baseRateBps: 2500,
      tierRateBps: 3000,
      tierThreshold: 10,
      capMonths: 12,
      holdDays: 30,
      minPayout: "100",
      reservePct: 25,
      reserveDays: 90,
    }
  }

  const basePct = (terms.baseRateBps / 100).toFixed(0)
  const tierPct = (terms.tierRateBps / 100).toFixed(0)

  return (
    <div className="mx-auto max-w-4xl px-4 py-16">
      <header className="mb-12 text-center">
        <h1 className="text-4xl font-bold tracking-tight">LyraShield AI Affiliate Program</h1>
        <p className="mt-4 text-lg text-muted-foreground">
          Earn recurring commissions by referring customers to the evidence-backed release assurance
          platform for AI-built software.
        </p>
      </header>

      <section className="mb-12">
        <h2 className="mb-6 text-2xl font-semibold">Commission Structure</h2>
        <div className="grid gap-6 sm:grid-cols-3">
          <div className="rounded-lg border p-6">
            <div className="text-3xl font-bold">{basePct}%</div>
            <p className="mt-2 text-sm text-muted-foreground">
              Recurring commission on Cloud subscriptions for {terms.capMonths} months from the
              customer&apos;s first payment.
            </p>
          </div>
          <div className="rounded-lg border p-6">
            <div className="text-3xl font-bold">{tierPct}%</div>
            <p className="mt-2 text-sm text-muted-foreground">
              Elevated rate once you reach {terms.tierThreshold}+ active referred subscriptions.
            </p>
          </div>
          <div className="rounded-lg border p-6">
            <div className="text-3xl font-bold">20%</div>
            <p className="mt-2 text-sm text-muted-foreground">
              One-time commission on Local-license (self-hosted) purchases.
            </p>
          </div>
        </div>
      </section>

      <section className="mb-12">
        <h2 className="mb-6 text-2xl font-semibold">How It Works</h2>
        <ol className="space-y-4">
          <li className="flex gap-4">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
              1
            </span>
            <div>
              <h3 className="font-semibold">Apply</h3>
              <p className="text-sm text-muted-foreground">
                Submit your application with details about your audience and promotion methods.
              </p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
              2
            </span>
            <div>
              <h3 className="font-semibold">Get Approved</h3>
              <p className="text-sm text-muted-foreground">
                Our team reviews your application. Once approved, you get access to your affiliate
                dashboard, referral links, and promo codes.
              </p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
              3
            </span>
            <div>
              <h3 className="font-semibold">Promote</h3>
              <p className="text-sm text-muted-foreground">
                Share your referral link or promo code with your audience. Track clicks, signups,
                and conversions in real time.
              </p>
            </div>
          </li>
          <li className="flex gap-4">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
              4
            </span>
            <div>
              <h3 className="font-semibold">Earn</h3>
              <p className="text-sm text-muted-foreground">
                Earn recurring commissions on every paid subscription. Payouts are processed monthly
                on the 15th (net-30) with a ${terms.minPayout}
                minimum.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section className="mb-12">
        <h2 className="mb-6 text-2xl font-semibold">Program Terms</h2>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>
            <strong>Attribution window:</strong> 60 days (last-click wins, promo code overrides
            cookie)
          </li>
          <li>
            <strong>Commission cap:</strong> {terms.capMonths} months from the customer&apos;s first
            payment
          </li>
          <li>
            <strong>Hold period:</strong> {terms.holdDays} days before commissions become available
            for payout
          </li>
          <li>
            <strong>Minimum payout:</strong> ${terms.minPayout}
          </li>
          <li>
            <strong>Payout schedule:</strong> Monthly net-30 on the 15th
          </li>
          <li>
            <strong>New-affiliate reserve:</strong> {terms.reservePct}% held for first{" "}
            {terms.reserveDays} days
          </li>
          <li>
            <strong>Payout methods:</strong> RazorpayX (India), Payoneer (global), BriskPe
            (RBI-native fallback)
          </li>
          <li>
            <strong>No commission on:</strong> Minute packs, trial signups, or self-referrals
          </li>
        </ul>
      </section>

      <div className="text-center">
        <Link
          href="/affiliates/apply"
          className="inline-flex items-center justify-center rounded-lg bg-primary px-8 py-3 text-primary-foreground font-semibold hover:bg-primary/90"
        >
          Apply Now
        </Link>
      </div>
    </div>
  )
}
