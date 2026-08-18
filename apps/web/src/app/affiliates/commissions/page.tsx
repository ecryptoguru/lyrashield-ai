import { redirect } from "next/navigation"
import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"
import { PageHeader } from "@/components/page-header"

export const metadata = {
  title: "Commissions — Affiliate Dashboard — LyraShield AI",
}

export default async function AffiliateCommissionsPage() {
  const session = await getCachedSession()
  if (!session) return null

  const affiliate = await prisma.affiliate.findUnique({
    where: { userId: session.userId },
    select: { id: true, status: true },
  })

  if (!affiliate || affiliate.status !== "APPROVED") {
    redirect("/affiliates/apply")
  }

  const commissions = await prisma.commission.findMany({
    where: { affiliateId: affiliate.id },
    orderBy: { earnedAt: "desc" },
    take: 200,
    select: {
      id: true,
      earnedAt: true,
      availableAt: true,
      rateBps: true,
      amount: true,
      currency: true,
      status: true,
      reversalOfId: true,
      conversion: {
        select: {
          id: true,
          occurredAt: true,
          method: true,
        },
      },
    },
  })

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader
        title="Commission Ledger"
        description="Immutable record of all commissions earned."
      />

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="pb-2 pr-4">Earned At</th>
              <th className="pb-2 pr-4">Release At</th>
              <th className="pb-2 pr-4">Rate</th>
              <th className="pb-2 pr-4">Amount</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Method</th>
              <th className="pb-2 pr-4">Reversal</th>
            </tr>
          </thead>
          <tbody>
            {commissions.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-muted-foreground">
                  No commissions yet.
                </td>
              </tr>
            ) : (
              commissions.map((c) => (
                <tr key={c.id} className="border-b">
                  <td className="py-2 pr-4">
                    {new Date(c.earnedAt).toLocaleDateString()}
                  </td>
                  <td className="py-2 pr-4">
                    {c.availableAt
                      ? new Date(c.availableAt).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="py-2 pr-4">{c.rateBps / 100}%</td>
                  <td className="py-2 pr-4">
                    {c.amount.toString()} {c.currency}
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        c.status === "PAID"
                          ? "bg-green-100 text-green-800"
                          : c.status === "AVAILABLE"
                            ? "bg-blue-100 text-blue-800"
                            : c.status === "PENDING"
                              ? "bg-yellow-100 text-yellow-800"
                              : c.status === "REVERSED"
                                ? "bg-red-100 text-red-800"
                                : c.status === "EXPIRED"
                                  ? "bg-gray-100 text-gray-600"
                                  : "bg-muted"
                      }`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4">{c.conversion.method}</td>
                  <td className="py-2 pr-4">
                    {c.reversalOfId ? (
                      <span className="text-xs text-red-600">
                        Reversal of {c.reversalOfId.slice(0, 8)}...
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
