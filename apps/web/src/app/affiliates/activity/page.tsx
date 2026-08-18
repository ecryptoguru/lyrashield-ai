import { redirect } from "next/navigation"
import { prisma } from "@lyrashield/db"
import { getCachedSession } from "@/lib/cache"
import { PageHeader } from "@/components/page-header"
import { ActivityTabs } from "./activity-tabs"

export const metadata = {
  title: "Activity — Affiliate Dashboard — LyraShield AI",
}

/** Mask a customer id: cus_abc123 → cus_*** */
function maskCustomerId(id: string): string {
  if (id.length <= 4) return "***"
  const prefix = id.slice(0, 4)
  return `${prefix}***`
}

export default async function AffiliateActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; page?: string }>
}) {
  const session = await getCachedSession()
  if (!session) return null

  const affiliate = await prisma.affiliate.findUnique({
    where: { userId: session.userId },
    select: { id: true, status: true },
  })

  if (!affiliate || affiliate.status !== "APPROVED") {
    redirect("/affiliates/apply")
  }

  const params = await searchParams
  const tab = params.tab ?? "clicks"
  const page = Math.max(1, parseInt(params.page ?? "1", 10))
  const pageSize = 50
  const skip = (page - 1) * pageSize

  let data: Record<string, unknown>[] = []
  let total = 0

  if (tab === "clicks") {
    const [clicks, count] = await Promise.all([
      prisma.click.findMany({
        where: { affiliateId: affiliate.id },
        orderBy: { clickedAt: "desc" },
        skip,
        take: pageSize,
        select: {
          id: true,
          clickedAt: true,
          landingUrl: true,
          referrer: true,
          subid: true,
          visitorId: true,
        },
      }),
      prisma.click.count({ where: { affiliateId: affiliate.id } }),
    ])
    data = clicks
    total = count
  } else if (tab === "signups") {
    const [users, count] = await Promise.all([
      prisma.user.findMany({
        where: { affiliate: { id: affiliate.id } },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        select: {
          id: true,
          createdAt: true,
          // Never expose email/name/PII — only masked id
        },
      }),
      prisma.user.count({ where: { affiliate: { id: affiliate.id } } }),
    ])
    // Mask user ids for privacy
    data = users.map((u) => ({
      id: maskCustomerId(u.id),
      createdAt: u.createdAt,
    }))
    total = count
  } else if (tab === "conversions") {
    const [convs, count] = await Promise.all([
      prisma.conversion.findMany({
        where: { affiliateId: affiliate.id },
        orderBy: { occurredAt: "desc" },
        skip,
        take: pageSize,
        select: {
          id: true,
          occurredAt: true,
          commissionableAmount: true,
          currency: true,
          method: true,
          promoCode: true,
          subid: true,
          commissions: {
            select: { rateBps: true, amount: true, status: true },
          },
        },
      }),
      prisma.conversion.count({ where: { affiliateId: affiliate.id } }),
    ])
    // Mask customer info — only show conversion-level data
    data = convs.map((c) => ({
      id: c.id,
      occurredAt: c.occurredAt,
      commissionableAmount: c.commissionableAmount.toString(),
      currency: c.currency,
      method: c.method,
      promoCode: c.promoCode,
      subid: c.subid,
      rateBps: c.commissions[0]?.rateBps,
      commissionAmount: c.commissions[0]?.amount.toString(),
      status: c.commissions[0]?.status,
    }))
    total = count
  }

  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader
        title="Activity"
        description="Clicks, signups, and conversions attributed to your referrals."
      />

      <ActivityTabs currentTab={tab} />

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              {tab === "clicks" && (
                <>
                  <th className="pb-2 pr-4">Date</th>
                  <th className="pb-2 pr-4">SubID</th>
                  <th className="pb-2 pr-4">Landing URL</th>
                  <th className="pb-2 pr-4">Referrer</th>
                </>
              )}
              {tab === "signups" && (
                <>
                  <th className="pb-2 pr-4">Date</th>
                  <th className="pb-2 pr-4">User (masked)</th>
                </>
              )}
              {tab === "conversions" && (
                <>
                  <th className="pb-2 pr-4">Date</th>
                  <th className="pb-2 pr-4">Amount</th>
                  <th className="pb-2 pr-4">Rate</th>
                  <th className="pb-2 pr-4">Commission</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Method</th>
                  <th className="pb-2 pr-4">SubID</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {data.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-muted-foreground">
                  No {tab} found.
                </td>
              </tr>
            ) : (
              data.map((row, i) => (
                <tr key={i} className="border-b">
                  {tab === "clicks" && (
                    <>
                      <td className="py-2 pr-4">
                        {new Date(row.clickedAt as string).toLocaleDateString()}
                      </td>
                      <td className="py-2 pr-4">{(row.subid as string) ?? "—"}</td>
                      <td className="py-2 pr-4 max-w-xs truncate">
                        {(row.landingUrl as string) ?? "—"}
                      </td>
                      <td className="py-2 pr-4 max-w-xs truncate">
                        {(row.referrer as string) ?? "—"}
                      </td>
                    </>
                  )}
                  {tab === "signups" && (
                    <>
                      <td className="py-2 pr-4">
                        {new Date(row.createdAt as string).toLocaleDateString()}
                      </td>
                      <td className="py-2 pr-4 font-mono">{row.id as string}</td>
                    </>
                  )}
                  {tab === "conversions" && (
                    <>
                      <td className="py-2 pr-4">
                        {new Date(row.occurredAt as string).toLocaleDateString()}
                      </td>
                      <td className="py-2 pr-4">
                        {row.commissionableAmount as string} {row.currency as string}
                      </td>
                      <td className="py-2 pr-4">
                        {row.rateBps ? `${(row.rateBps as number) / 100}%` : "—"}
                      </td>
                      <td className="py-2 pr-4">
                        {row.commissionAmount as string} {row.currency as string}
                      </td>
                      <td className="py-2 pr-4">
                        <span className="rounded px-2 py-0.5 text-xs font-medium">
                          {row.status as string}
                        </span>
                      </td>
                      <td className="py-2 pr-4">{row.method as string}</td>
                      <td className="py-2 pr-4">{(row.subid as string) ?? "—"}</td>
                    </>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages} ({total} total)
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <a
                href={`/affiliates/activity?tab=${tab}&page=${page - 1}`}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Previous
              </a>
            )}
            {page < totalPages && (
              <a
                href={`/affiliates/activity?tab=${tab}&page=${page + 1}`}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Next
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
