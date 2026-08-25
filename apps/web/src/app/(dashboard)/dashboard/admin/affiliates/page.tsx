import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { isPlatformOperator } from "@lyrashield/auth/server"
import { AffiliateAdminActions } from "./admin-actions"

export const metadata = {
  title: "Affiliate Admin",
}

export default async function AffiliateAdminPage() {
  const session = await getCachedSession()
  if (!session) return null

  // Global affiliate administration is platform-operator authority — it never
  // derives from workspace membership or tenant roles.
  if (!(await isPlatformOperator(session.userId))) {
    redirect("/dashboard")
  }

  const [pending, approved, suspended, payouts] = await Promise.all([
    prisma.affiliate.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { email: true, name: true } },
      },
    }),
    prisma.affiliate.findMany({
      where: { status: "APPROVED" },
      orderBy: { approvedAt: "desc" },
      include: {
        user: { select: { email: true, name: true } },
        _count: {
          select: { commissions: true, payouts: true, clicks: true },
        },
      },
    }),
    prisma.affiliate.findMany({
      where: { status: "SUSPENDED" },
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { email: true, name: true } },
      },
    }),
    prisma.payout.findMany({
      // C-M10: Query both PENDING and PROCESSING — requestPayout creates as
      // PROCESSING, so querying only PENDING made all payouts invisible.
      where: { status: { in: ["PENDING", "PROCESSING"] } },
      orderBy: { requestedAt: "desc" },
      take: 20,
      include: {
        affiliate: {
          include: {
            user: { select: { email: true, name: true } },
          },
        },
      },
    }),
  ])

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader
        title="Affiliate Admin"
        description="Review applications, affiliates, and payouts. Changes remain disabled until one-time authorization and atomic audit controls are connected."
      />

      <section className="mt-6">
        <h2 className="mb-4 text-lg font-semibold">Approval Queue ({pending.length})</h2>
        <div className="space-y-3">
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending applications.</p>
          ) : (
            pending.map((aff) => (
              <div key={aff.id} className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <div className="font-medium">{aff.user.name ?? aff.user.email}</div>
                  <div className="text-sm text-muted-foreground">
                    Applied {new Date(aff.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <AffiliateAdminActions affiliateId={aff.id} />
              </div>
            ))
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-4 text-lg font-semibold">Approved Affiliates ({approved.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="pb-2 pr-4">Affiliate</th>
                <th className="pb-2 pr-4">Active Referrals</th>
                <th className="pb-2 pr-4">Commissions</th>
                <th className="pb-2 pr-4">Clicks</th>
                <th className="pb-2 pr-4">Payouts</th>
                <th className="pb-2 pr-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {approved.map((aff) => (
                <tr key={aff.id} className="border-b">
                  <td className="py-2 pr-4">{aff.user.name ?? aff.user.email}</td>
                  <td className="py-2 pr-4">{aff.activeReferrals}</td>
                  <td className="py-2 pr-4">{aff._count.commissions}</td>
                  <td className="py-2 pr-4">{aff._count.clicks}</td>
                  <td className="py-2 pr-4">{aff._count.payouts}</td>
                  <td className="py-2 pr-4">
                    <AffiliateAdminActions
                      affiliateId={aff.id}
                      showSuspend
                      showTierOverride
                      showPayoutProfileVerification
                      currentPayoutMethodVerified={Boolean(aff.payoutMethodVerifiedAt)}
                      currentTaxStatus={
                        aff.taxFormStatus as
                          "PENDING_REVIEW" | "VERIFIED" | "REJECTED" | "NOT_SUBMITTED"
                      }
                      currentBaseRate={aff.baseRateBps}
                      currentTierRate={aff.tierRateBps}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-4 text-lg font-semibold">Pending Payouts ({payouts.length})</h2>
        <div className="space-y-3">
          {payouts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending payouts.</p>
          ) : (
            payouts.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <div className="font-medium">
                    {p.affiliate.user.name ?? p.affiliate.user.email}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {p.amount.toString()} {p.currency} · Requested{" "}
                    {new Date(p.requestedAt).toLocaleDateString()}
                  </div>
                </div>
                <AffiliateAdminActions
                  payoutId={p.id}
                  showPayoutReconcile
                  currentProviderPayoutId={p.providerPayoutId}
                />
              </div>
            ))
          )}
        </div>
      </section>

      {suspended.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 text-lg font-semibold">Suspended Affiliates ({suspended.length})</h2>
          <div className="space-y-3">
            {suspended.map((aff) => (
              <div key={aff.id} className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <div className="font-medium">{aff.user.name ?? aff.user.email}</div>
                </div>
                <AffiliateAdminActions affiliateId={aff.id} showReactivate />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
