import { redirect } from "next/navigation"
import { prisma, Prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"
import { PageHeader } from "@/components/page-header"
import { PayoutRequestButton } from "./payout-request-button"
import { PayoutMethodForm } from "./payout-method-form"
import { checkPayoutEligibility, computeReserve } from "@lyrashield/affiliate"
import { env } from "@lyrashield/config"

export const metadata = {
  title: "Payouts — Affiliate Dashboard — LyraShield AI",
}

export default async function AffiliatePayoutsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const affiliate = await prisma.affiliate.findUnique({
    where: { userId: session.userId },
    select: {
      id: true,
      status: true,
      payoutMethod: true,
      reservePct: true,
      reserveUntil: true,
      payouts: {
        orderBy: { requestedAt: "desc" },
        take: 20,
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          provider: true,
          requestedAt: true,
          paidAt: true,
          failureCode: true,
        },
      },
    },
  })

  if (!affiliate || affiliate.status !== "APPROVED") {
    redirect("/affiliates/apply")
  }

  const [pending, available, paid, lifetime] = await Promise.all([
    prisma.commission.aggregate({
      where: { affiliateId: affiliate.id, status: "PENDING" },
      _sum: { amount: true },
    }),
    prisma.commission.aggregate({
      where: { affiliateId: affiliate.id, status: "AVAILABLE" },
      _sum: { amount: true },
    }),
    prisma.commission.aggregate({
      where: { affiliateId: affiliate.id, status: "PAID" },
      _sum: { amount: true },
    }),
    prisma.commission.aggregate({
      where: {
        affiliateId: affiliate.id,
        status: { in: ["PAID", "AVAILABLE", "PENDING"] },
      },
      _sum: { amount: true },
    }),
  ])

  const eligibility = await checkPayoutEligibility(affiliate.id)
  const reserve = computeReserve({
    reservePct: affiliate.reservePct,
    reserveUntil: affiliate.reserveUntil,
  })

  const minPayoutUsd = env.AFFILIATE_PAYOUT_MIN_CENTS / 100

  // Calculate next payout date (15th of next month)
  const now = new Date()
  const nextPayout = new Date(now.getFullYear(), now.getMonth() + 1, 15)

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <PageHeader
        title="Payouts"
        description="Manage your payout method, view balances, and request payouts."
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">Pending</div>
          <div className="mt-1 text-2xl font-bold">
            ${Number((pending._sum.amount ?? new Prisma.Decimal(0)).toString()).toFixed(2)}
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">Available</div>
          <div className="mt-1 text-2xl font-bold">
            ${Number((available._sum.amount ?? new Prisma.Decimal(0)).toString()).toFixed(2)}
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">Paid (lifetime)</div>
          <div className="mt-1 text-2xl font-bold">
            ${Number((paid._sum.amount ?? new Prisma.Decimal(0)).toString()).toFixed(2)}
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">Lifetime Earnings</div>
          <div className="mt-1 text-2xl font-bold">
            ${Number((lifetime._sum.amount ?? new Prisma.Decimal(0)).toString()).toFixed(2)}
          </div>
        </div>
      </div>

      {reserve.active && (
        <div className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900 dark:bg-yellow-950">
          <h3 className="font-semibold text-yellow-800 dark:text-yellow-200">
            New-Affiliate Reserve Active
          </h3>
          <p className="mt-1 text-sm text-yellow-700 dark:text-yellow-300">
            {reserve.pct}% of your earnings are held in reserve for the first{" "}
            {reserve.daysRemaining} days. This reserve is released as your account establishes a
            track record.
          </p>
        </div>
      )}

      <div className="mt-6 rounded-lg border p-6">
        <h2 className="mb-4 text-lg font-semibold">Request a Payout</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Minimum payout: ${minPayoutUsd.toFixed(2)} · Next payout date:{" "}
          {nextPayout.toLocaleDateString()}
        </p>
        <PayoutRequestButton
          eligible={eligibility.eligible}
          reasons={eligibility.reasons}
          availableAmount={eligibility.availableAmount}
          affiliateId={affiliate.id}
        />
      </div>

      <div className="mt-6 rounded-lg border p-6">
        <h2 className="mb-4 text-lg font-semibold">Payout Method & Tax Form</h2>
        <PayoutMethodForm
          affiliateId={affiliate.id}
          currentMethod={affiliate.payoutMethod as Record<string, unknown> | null}
        />
      </div>

      <div className="mt-6">
        <h2 className="mb-4 text-lg font-semibold">Payout History</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="pb-2 pr-4">Date</th>
                <th className="pb-2 pr-4">Amount</th>
                <th className="pb-2 pr-4">Provider</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Paid At</th>
              </tr>
            </thead>
            <tbody>
              {affiliate.payouts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-muted-foreground">
                    No payouts yet.
                  </td>
                </tr>
              ) : (
                affiliate.payouts.map((p) => (
                  <tr key={p.id} className="border-b">
                    <td className="py-2 pr-4">{new Date(p.requestedAt).toLocaleDateString()}</td>
                    <td className="py-2 pr-4">
                      {p.amount.toString()} {p.currency}
                    </td>
                    <td className="py-2 pr-4">{p.provider ?? "—"}</td>
                    <td className="py-2 pr-4">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          p.status === "PAID"
                            ? "bg-green-100 text-green-800"
                            : p.status === "PROCESSING"
                              ? "bg-blue-100 text-blue-800"
                              : p.status === "FAILED"
                                ? "bg-red-100 text-red-800"
                                : "bg-muted"
                        }`}
                      >
                        {p.status}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      {p.paidAt ? new Date(p.paidAt).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
